import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID,
  waitForTranscriptIdle
} from './agent-transcript-pane-test-harness'
import metadata from './__fixtures__/hermes-slash-setup.meta.json'
import metadata022 from './__fixtures__/hermes-0-22-slash-setup.meta.json'
import profileMetadata from './__fixtures__/hermes-0-22-profile-prompt.meta.json'
import bottomMetadata from './__fixtures__/hermes-0-22-statusbar-bottom.meta.json'
import type { TerminalHandleRecord } from './runtime-terminal-contracts'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const captured = readFileSync(join(__dirname, '__fixtures__', 'hermes-slash-setup.txt'))
const captured022 = readFileSync(join(__dirname, '__fixtures__', 'hermes-0-22-slash-setup.txt'))

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

// Rows as Hermes paints them, for presentations no recording covers.
async function paneShowing(rows: string[], options: { paneTitle?: string } = {}) {
  const pane = await createTranscriptPane({
    paneTitle: options.paneTitle ?? 'Hermes Agent',
    foregroundProcess: 'hermes',
    launchAgent: 'hermes',
    size: { cols: 120, rows: 31 },
    data: rows.join('\r\n')
  })
  await pane.runtime.readTerminal(pane.handle, { screen: true })
  return pane
}

function useHandleRoute(
  pane: Awaited<ReturnType<typeof createTranscriptPane>>,
  route: 'pty' | 'leaf'
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Select the runtime's PTY handle record shape while retaining the synced leaf for adopted-title lookup.
  const internals = pane.runtime as unknown as {
    handles: Map<string, TerminalHandleRecord>
    getLivePtyForHandle: (handle: string) => unknown
  }
  expect(internals.getLivePtyForHandle(pane.handle)).toBeNull()
  if (route === 'pty') {
    const record = internals.handles.get(pane.handle)
    if (!record) {
      throw new Error('transcript handle missing')
    }
    internals.handles.set(pane.handle, {
      ...record,
      tabId: `pty:${TRANSCRIPT_PANE_PTY_ID}`,
      leafId: `pty:${TRANSCRIPT_PANE_PTY_ID}`,
      ptyGeneration: 0
    })
    expect(internals.getLivePtyForHandle(pane.handle)).not.toBeNull()
  }
}

describe('Hermes slash readiness from captured raw PTY bytes', () => {
  it.each(['initial', 'model', 'reasoning', 'completed'] as const)(
    'settles at %s without waiting for the repainting stream to go quiet',
    async (stage) => {
      const pane = await paneAt(stage)
      await expect(waitForTranscriptIdle(pane, 550)).resolves.toMatchObject({ satisfied: true })
    }
  )

  it.each(['starting', 'modelDraft', 'reasoningDraft', 'busy', 'streaming'] as const)(
    'does not settle at %s even after the quiet window',
    async (stage) => {
      const pane = await paneAt(stage)
      await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
    }
  )

  it('settles on an SSH-owned pane with the same captured screen', async () => {
    const pane = await paneAt('reasoning', { connectionId: 'ssh-host' })
    await expect(waitForTranscriptIdle(pane, 550)).resolves.toMatchObject({ satisfied: true })
  })

  it('does not let a session-boundary hook settle a still-starting screen', async () => {
    const pane = await paneAt('starting')
    pane.runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      `\x1b]9999;${JSON.stringify({
        state: 'done',
        agentType: 'hermes',
        sessionBoundary: true
      })}\x07`,
      Date.now()
    )
    await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
  })

  describe.each(['pty', 'leaf'] as const)(
    '%s handle with an explicit ready pane title',
    (route) => {
      it.each(['starting', 'busy'] as const)('holds on the captured %s screen', async (stage) => {
        const pane = await paneAt(stage, { paneTitle: 'Hermes ready' })
        useHandleRoute(pane, route)
        if (stage === 'starting') {
          pane.runtime.onPtyData(
            TRANSCRIPT_PANE_PTY_ID,
            `\x1b]9999;${JSON.stringify({
              state: 'done',
              agentType: 'hermes',
              sessionBoundary: true
            })}\x07`,
            Date.now()
          )
        }
        await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
      })

      it('holds while the recorded model picker owns input', async () => {
        const pane = await createTranscriptPane({
          paneTitle: 'Hermes ready',
          foregroundProcess: 'hermes',
          launchAgent: 'hermes',
          size: { cols: metadata.cols, rows: metadata.rows },
          data: readFileSync(join(__dirname, '__fixtures__', 'hermes-model-picker.txt'), 'utf8')
        })
        await pane.runtime.readTerminal(pane.handle, { screen: true })
        useHandleRoute(pane, route)
        await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
      })

      it('holds without a ready screen even after a session-boundary hook', async () => {
        const pane = await createTranscriptPane({
          paneTitle: 'Hermes ready',
          foregroundProcess: 'hermes',
          launchAgent: 'hermes',
          data: ''
        })
        useHandleRoute(pane, route)
        pane.runtime.onPtyData(
          TRANSCRIPT_PANE_PTY_ID,
          `\x1b]9999;${JSON.stringify({
            state: 'done',
            agentType: 'hermes',
            sessionBoundary: true
          })}\x07`,
          Date.now()
        )
        await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
      })

      it('settles when the captured ready composer is present', async () => {
        const pane = await paneAt('initial', { paneTitle: 'Hermes ready' })
        useHandleRoute(pane, route)
        await expect(waitForTranscriptIdle(pane, 550)).resolves.toMatchObject({ satisfied: true })
      })

      it('holds on an unsubmitted draft shaped like a placeholder', async () => {
        const pane = await paneShowing(
          ['─ ready │ example-model │ 1s', '❯ Try "run the migration"'],
          {
            paneTitle: 'Hermes ready'
          }
        )
        useHandleRoute(pane, route)
        await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
      })
    }
  )

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

  it('keeps active hook states ahead of an old ready screen', async () => {
    for (const state of ['working', 'waiting', 'blocked']) {
      const pane = await paneAt('reasoning')
      pane.runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        `\x1b]9999;${JSON.stringify({ state, agentType: 'hermes' })}\x07`,
        Date.now()
      )
      await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
    }
  })
})

describe('Hermes 0.22 readiness from captured raw PTY bytes', () => {
  async function paneAt022(stage: keyof typeof metadata022.stages) {
    const pane = await createTranscriptPane({
      paneTitle: 'Hermes Agent',
      foregroundProcess: 'hermes',
      launchAgent: 'hermes',
      size: { cols: metadata022.cols, rows: metadata022.rows },
      data: captured022.subarray(0, metadata022.stages[stage]).toString('utf8')
    })
    await pane.runtime.readTerminal(pane.handle, { screen: true })
    return pane
  }

  // `initial` is a fresh launch on the "Ask me anything…" composer placeholder.
  it.each(['initial', 'reasoning', 'completed'] as const)(
    'settles at %s without waiting for the repainting stream to go quiet',
    async (stage) => {
      const pane = await paneAt022(stage)
      await expect(waitForTranscriptIdle(pane, 550)).resolves.toMatchObject({ satisfied: true })
    }
  )

  it.each(['starting', 'reasoningDraft', 'promptDraft', 'busy', 'streaming'] as const)(
    'does not settle at %s even after the quiet window',
    async (stage) => {
      const pane = await paneAt022(stage)
      await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
    }
  )
})

describe.each([
  ['a named profile prompt', 'hermes-0-22-profile-prompt.txt', profileMetadata],
  ['the bottom statusbar', 'hermes-0-22-statusbar-bottom.txt', bottomMetadata]
] as const)('Hermes 0.22 readiness with %s', (_presentation, fixture, meta) => {
  const recording = readFileSync(join(__dirname, '__fixtures__', fixture))

  async function paneAtStage(stage: keyof typeof meta.stages) {
    const pane = await createTranscriptPane({
      paneTitle: 'Hermes Agent',
      foregroundProcess: 'hermes',
      launchAgent: 'hermes',
      size: { cols: meta.cols, rows: meta.rows },
      data: recording.subarray(0, meta.stages[stage]).toString('utf8')
    })
    await pane.runtime.readTerminal(pane.handle, { screen: true })
    return pane
  }

  it.each(['initial', 'completed'] as const)('settles at %s', async (stage) => {
    const pane = await paneAtStage(stage)
    await expect(waitForTranscriptIdle(pane, 550)).resolves.toMatchObject({ satisfied: true })
  })

  it.each(['starting', 'forging', 'promptDraft', 'busy', 'streaming', 'tryDraft'] as const)(
    'does not settle at %s even after the quiet window',
    async (stage) => {
      const pane = await paneAtStage(stage)
      await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
    }
  )
})

describe('Hermes readiness with the battery read-out', () => {
  it.each(['🔋 80%', '⚡ 100%'])('settles on a ready row led by %s', async (battery) => {
    const pane = await paneShowing([
      `─ ${battery} │ ready │ example-model │ 1s`,
      '❯ Ask me anything…'
    ])
    await expect(waitForTranscriptIdle(pane, 550)).resolves.toMatchObject({ satisfied: true })
  })

  // Built-in skins (hermes_cli/skin_engine.py) replace ❯ with their own prompt symbol.
  it.each(['⚔', 'Ψ', '◉', '✦'])(
    'settles on a ready composer drawn with the %s skin',
    async (symbol) => {
      const pane = await paneShowing(['─ ready │ example-model │ 1s', `${symbol} Ask me anything…`])
      await expect(waitForTranscriptIdle(pane, 550)).resolves.toMatchObject({ satisfied: true })
    }
  )

  it.each([
    ['starting', '─ 🔋 80% │ summoning hermes… │  │ voice off', '❯ Ask me anything…'],
    ['busy', '─ 🔋 80% │ (｡•́︿•̀｡) analyzing… · 1s │ example-model', '❯ Ctrl+C to interrupt…'],
    ['a draft', '─ 🔋 80% │ ready │ example-model │ 1s', '❯ hello']
  ])('does not settle on %s', async (_stage, statusRow, composerRow) => {
    const pane = await paneShowing([statusRow, composerRow])
    await expect(waitForTranscriptIdle(pane, 8_000)).rejects.toThrow('timeout')
  })
})
