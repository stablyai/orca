import { describe, expect, it, vi } from 'vitest'
import {
  finalReplayFrame,
  readRuntimeFixture,
  replayTranscript
} from './agent-transcript-replay-test-harness'
import {
  describeScreenRuledAgentTranscripts,
  readsIdleComposer
} from './screen-ruled-agent-transcript-suite'

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

function screenOf(lines: readonly string[]): string {
  return lines.join('\n')
}

describe('Prime Agent readiness from captured bytes', () => {
  describeScreenRuledAgentTranscripts({
    agent: 'prime-agent',
    foregroundProcess: 'prime-agent',
    ready: READY,
    notReady: NOT_READY,
    // Why all: an idle Prime is quiet, so the quiet-process lane settles it.
    readyWithoutScreen: READY.map(({ name }) => name)
  })

  // Why the footer is no ready signal (#22153): it and the bare caret stay painted mid-turn.
  it('keeps the footer and the bare caret on screen mid-turn', async () => {
    const { ruledScreenLines } = await finalReplayFrame('prime-agent-0-9-8-busy-streaming', 120, 40)
    expect(ruledScreenLines.at(-1)?.trim().startsWith('← manage')).toBe(true)
    expect(ruledScreenLines.at(-2)?.trim()).toBe('>')
    expect(screenOf(ruledScreenLines)).toMatch(/[⠀-⣿] Writing/)
  })

  // Why a clocked pane waits for quiet: the rule reads these frames as ready, and only the
  // spinner ticks and the question's animation keep the stream from going quiet.
  it.each([
    ['prime-agent-0-9-8-busy-streaming', 'a spinner row erased before its redraw', 'Without using'],
    ['prime-agent-0-9-8-trace-question', 'the composer painted before the question', null]
  ])('%s: the screen alone reads ready during %s', async (name, _what, submittedMarker) => {
    let readyAfterMarker = 0
    let markerSeen = submittedMarker === null
    let questionSeen = false
    for await (const { ruledScreenLines } of replayTranscript(readRuntimeFixture(name), 120, 40)) {
      const screen = screenOf(ruledScreenLines)
      markerSeen ||= submittedMarker !== null && screen.includes(submittedMarker)
      questionSeen ||= screen.includes('Share agent traces')
      if (markerSeen && !questionSeen && readsIdleComposer('prime-agent', ruledScreenLines)) {
        readyAfterMarker += 1
      }
    }
    expect(readyAfterMarker).toBeGreaterThan(0)
  })
})
