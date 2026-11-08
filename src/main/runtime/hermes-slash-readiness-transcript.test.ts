import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID,
  waitForTranscriptIdle
} from './orca-runtime-tests/agent-transcript-pane-test-harness'
import metadata from './__fixtures__/hermes-slash-setup.meta.json'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const captured = readFileSync(join(__dirname, '__fixtures__', 'hermes-slash-setup.txt'))

async function paneAt(
  stage: keyof typeof metadata.stages,
  options: { connectionId?: string; paneTitle?: string } = {}
) {
  const pane = await createTranscriptPane({
    paneTitle: options.paneTitle ?? 'Hermes Agent',
    foregroundProcess: 'hermes',
    launchAgent: 'hermes',
    connectionId: options.connectionId,
    size: { cols: metadata.cols, rows: metadata.rows },
    data: captured.subarray(0, metadata.stages[stage]).toString('utf8')
  })
  await pane.runtime.readTerminal(pane.handle, { screen: true })
  return pane
}

describe('Hermes slash readiness from captured raw PTY bytes', () => {
  it('does not treat a turn-end hook as a completed screen', async () => {
    const pane = await paneAt('busy')
    pane.runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      `\x1b]9999;${JSON.stringify({ state: 'done', agentType: 'hermes' })}\x07`,
      Date.now()
    )
    await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
    pane.runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      captured.subarray(metadata.stages.busy, metadata.stages.completed).toString('utf8'),
      Date.now()
    )
    await pane.runtime.readTerminal(pane.handle, { screen: true })
    await expect(waitForTranscriptIdle(pane, 550)).resolves.toMatchObject({ satisfied: true })
  })

  it('settles despite continuous recorded status repaints', async () => {
    const pane = await paneAt('reasoning')
    // These bytes contain only the recorded elapsed-time updates after the acknowledgement.
    const repaint = captured.subarray(32377, 33100).toString('utf8')
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
    })
    const timer = setInterval(
      () => pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, repaint, Date.now()),
      200
    )
    try {
      const waiting = pane.runtime.waitForTerminal(pane.handle, {
        condition: 'tui-idle',
        timeoutMs: 8_000
      })
      void waiting.catch(() => {})
      await vi.advanceTimersByTimeAsync(8_000)
      await expect(waiting).resolves.toMatchObject({ satisfied: true })
    } finally {
      clearInterval(timer)
      vi.useRealTimers()
    }
  })
})

describe('Hermes readiness on the classic screen (#35883)', () => {
  // The classic screen (hermes without --tui, e.g. `hermes -p <profile>
  // --model <model>`) paints no `─ ready │` status row. Idle shows the prompt
  // row with one of the empty-composer placeholders from locales/en.yaml
  // (placeholder.p01–p11, rotating) and the bottom bar's right segment reads
  // `/ commands · @ files · ! shell`. The rows below come from the issue's
  // captured screen; presentations no recording covers use paneShowing by
  // house precedent.
  it('settles on the classic idle screen captured in the issue', async () => {
    // The captured screen is wider than the 120-column paneShowing fixture;
    // the bottom-bar gap is compressed to fit, keeping every painted segment.
    const pane = await paneShowing([
      'reviewer ❯ Explain this error and how to fix it',
      '────────────────────────────────────────────────────────────',
      ' ☤ review · ctx -- · [░░░░░░░░░░] -- · 1s · ⏲ 0s    / commands · @ files · ! shell'
    ])
    await expect(waitForTranscriptIdle(pane, 550)).resolves.toMatchObject({ satisfied: true })
  })

  it.each([
    'Ask anything, or type / for commands…',
    "Summarize what's in this folder",
    'Plan a feature, then build it step by step',
    'What changed in this repo recently?',
    'Type / to browse commands, or Ctrl+P for the palette'
  ])('settles on the rotating placeholder %s', async (placeholder) => {
    const pane = await paneShowing([
      `reviewer ❯ ${placeholder}`,
      '────────────────────────────────────────────────────────────',
      ' ☤ review · ctx -- · [░░░░░░░░░░] -- · 1s · ⏲ 0s    / commands · @ files · ! shell'
    ])
    await expect(waitForTranscriptIdle(pane, 550)).resolves.toMatchObject({ satisfied: true })
  })

  it('settles without a profile prefix and without the separator rule line', async () => {
    const pane = await paneShowing([
      '❯ Explain this error and how to fix it',
      ' ☤ review · ctx -- · [░░░░░░░░░░] -- · 1s · ⏲ 0s    / commands · @ files · ! shell'
    ])
    await expect(waitForTranscriptIdle(pane, 550)).resolves.toMatchObject({ satisfied: true })
  })

  it.each([
    [
      'a running turn',
      '❯ type to redirect this turn · Tab queues it for after',
      ' ☤ review · ctx -- · [░░░░░░░░░░] -- · 12s · ⏲ 3s    enter interrupt · tab queue · ctrl+c stop'
    ],
    [
      'a draft',
      'reviewer ❯ my own draft text',
      ' ☤ review · ctx -- · [░░░░░░░░░░] -- · 1s · ⏲ 0s    / commands · @ files · ! shell'
    ]
  ])('does not settle on %s', async (_stage, composerRow, barRow) => {
    const pane = await paneShowing([composerRow, '──────────────────────', barRow])
    await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
  })
})
