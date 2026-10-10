import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { FakeDaemonModel } from './fake-daemon-terminal-model.test-fixture'
import { MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS } from './main-terminal-model-dormancy'

const SIZE = { cols: 80, rows: 24 }

/** An agent pane on a local daemon whose output went quiet long enough for main's model to rest. */
async function createQuietAgentPane(agent: TuiAgent, output: string) {
  const daemon = new FakeDaemonModel(SIZE)
  const pane = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: null,
    launchAgent: agent,
    size: SIZE,
    data: '',
    settledDaemonSnapshot: () => daemon.snapshot()
  })
  // Why only Date: emulator writes settle on real timers; the quiet period is measured by Date.now.
  vi.useFakeTimers({ toFake: ['Date'] })
  const emit = async (data: string): Promise<void> => {
    await daemon.feed(data)
    pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data, Date.now())
  }
  await emit(output)
  vi.setSystemTime(Date.now() + MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS)
  // Why a no-op chunk: main lets its model go at the first chunk after the quiet period.
  await emit('\x1b[?25l')
  return pane
}

describe("main's terminal model for an agent pane", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each<TuiAgent>(['claude', 'gemini', 'opencode'])(
    'rests for %s, whose readiness reads no screen',
    async (agent) => {
      const { runtime } = await createQuietAgentPane(agent, 'ready\r\n')
      expect(runtime.isMainTerminalModelDormant(TRANSCRIPT_PANE_PTY_ID)).toBe(true)
    }
  )

  it.each<TuiAgent>(['codex', 'cline', 'antigravity', 'qoder', 'omp', 'freebuff'])(
    "stays live for %s, which reads main's screen",
    async (agent) => {
      const { runtime } = await createQuietAgentPane(agent, 'ready\r\n')
      expect(runtime.isMainTerminalModelDormant(TRANSCRIPT_PANE_PTY_ID)).toBe(false)
    }
  )

  it('reads the rebuilt screen for a one-shot check instead of no screen', async () => {
    const { runtime } = await createQuietAgentPane('claude', 'Do you trust this folder?\r\n')
    expect(runtime.isMainTerminalModelDormant(TRANSCRIPT_PANE_PTY_ID)).toBe(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both readers are protected runtime methods; the test only calls them.
    const internals = runtime as unknown as {
      readLiveTerminalScreenLines(ptyId: string): string[] | null
      readSettledLiveTerminalScreenLines(ptyId: string): Promise<string[] | null>
    }
    const settled = internals.readSettledLiveTerminalScreenLines(TRANSCRIPT_PANE_PTY_ID)
    // The synchronous read sees the rebuild in flight and reports no screen.
    expect(internals.readLiveTerminalScreenLines(TRANSCRIPT_PANE_PTY_ID)).toBeNull()
    expect(await settled).toContain('Do you trust this folder?')
  })
})
