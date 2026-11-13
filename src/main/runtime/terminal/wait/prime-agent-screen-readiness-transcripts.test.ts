import { describe, expect, it, vi } from 'vitest'
import {
  finalReplayFrame,
  finalProviderSnapshot,
  readRuntimeFixture
} from './agent-transcript-replay-test-harness'
import { evaluateAgentStateRules } from '../../agent-state-rules/agent-state-rules-engine'

import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// prime-agent 0.9.8 on macOS, OpenRouter, isolated HOME; 0.9.5 recorded for PR #22154 (see
// each .meta.json); STA-8741.
const at120x40 = (name: string, what: string) => ({ name, what, cols: 120, rows: 40 })
const at120x35 = (name: string, what: string) => ({ name, what, cols: 120, rows: 35 })
const READY = [
  at120x40('prime-agent-0-9-8-ready', 'settled startup'),
  at120x40('prime-agent-0-9-8-ready-after-question', 'trace question answered Not now'),
  { name: 'prime-agent-0-9-8-ready-80x24', what: 'settled startup', cols: 80, rows: 24 },
  at120x40('prime-agent-0-9-8-turn-ended', 'a turn has ended'),
  at120x40('prime-agent-0-9-8-tool-turn', 'a turn with a tool call has ended'),
  at120x35('prime-agent-0-9-5-ready', '0.9.5 settled startup'),
  at120x35('prime-agent-0-9-5-turn', '0.9.5 turn ended')
]
const NOT_READY = [
  at120x40('prime-agent-0-9-8-trace-question', 'first-launch trace-sharing question'),
  at120x40('prime-agent-0-9-8-slash-menu', 'slash menu open'),
  at120x40('prime-agent-0-9-8-busy-streaming', 'answer streaming'),
  at120x40('prime-agent-0-9-8-draft', 'unsent text in the composer')
]

describe('Prime Agent readiness from captured bytes', () => {
  it('keeps live application zones in the restored alternate screen without a provider capture', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Prime Agent',
      foregroundProcess: 'prime-agent',
      data: '',
      size: { cols: 120, rows: 40 }
    })
    const enter = '\x1b[?1049h'
    runtime.seedHeadlessTerminal(
      TRANSCRIPT_PANE_PTY_ID,
      enter,
      { cols: 120, rows: 40 },
      { replaceExisting: true }
    )
    await runtime.readTerminal(handle, { screen: true })
    const recording = readRuntimeFixture('prime-agent-0-9-8-turn-ended')
    vi.useFakeTimers()
    try {
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        recording.slice(recording.indexOf(enter) + enter.length),
        Date.now()
      )
      const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
      await vi.advanceTimersByTimeAsync(4_000)
      await expect(wait).resolves.toMatchObject({ satisfied: true })
    } finally {
      vi.useRealTimers()
    }
  })
  it('settles a restored pane from its current provider frame', async () => {
    const snapshot = await finalProviderSnapshot('prime-agent-0-9-8-turn-ended', 120, 40)
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: 'prime-agent',
      launchAgent: 'prime-agent',
      data: '',
      size: { cols: 120, rows: 40 },
      serializeProviderBuffer: async () => snapshot
    })
    vi.useFakeTimers()
    try {
      const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
      await vi.advanceTimersByTimeAsync(4_000)
      await expect(wait).resolves.toMatchObject({ satisfied: true })
    } finally {
      vi.useRealTimers()
    }
  })
  it.each(READY)('$name ($what) reads ready', async ({ name, cols, rows }) => {
    const { ruledScreenLines } = await finalReplayFrame(name, cols, rows)
    expect(
      evaluateAgentStateRules('prime-agent', { readScreenLines: () => ruledScreenLines })?.state
    ).toBe('idle')
  })

  it.each(NOT_READY)('$name ($what) does not read ready', async ({ name, cols, rows }) => {
    const { ruledScreenLines } = await finalReplayFrame(name, cols, rows)
    expect(
      evaluateAgentStateRules('prime-agent', { readScreenLines: () => ruledScreenLines })?.state
    ).not.toBe('idle')
  })
})
