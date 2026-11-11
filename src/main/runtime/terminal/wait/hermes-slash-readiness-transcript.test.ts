import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID,
  waitForTranscriptIdle
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'
import metadata from '../../__fixtures__/hermes-slash-setup.meta.json'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const captured = readFileSync(join(__dirname, '..', '..', '__fixtures__', 'hermes-slash-setup.txt'))

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
