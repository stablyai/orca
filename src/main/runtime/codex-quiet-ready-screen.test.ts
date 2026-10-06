import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import { createTranscriptPane, waitForTranscriptIdle } from './agent-transcript-pane-test-harness'
import {
  readRuntimeFixture,
  replayTranscript,
  type TranscriptReplayFrame
} from './agent-transcript-replay-test-harness'
import { isCodexComposerReadyScreen } from './agent-state-rules/codex-screen-predicates'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptBody,
  isKnownReadyPromptPreview,
  isQuietReadyScreenBody
} from './terminal-wait-detection'
import {
  evaluateTuiIdle,
  hasQuietReadyScreen,
  isTuiIdleReadyVerdict,
  type TuiIdleEvaluationInput
} from './tui-idle-evidence'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const QUIESCENCE_MS = 3000

// codex-cli recordings at 120x40 (see each .meta.json); STA-8834. Each launches, runs a turn,
// and ends idle; the timed ones also replay as plain strings here. 0.157 idles via STA-8628's.
const TIMED_FIXTURES = ['codex-0-155-1-timed-turn', 'codex-0-158-0-timed-turn']
const SETTLED_IDLE_FIXTURES = ['codex-0-150-1-turn', ...TIMED_FIXTURES]
const DIALOG_FIXTURES = [
  'codex-0-157-1-update-dialog',
  'codex-0-158-0-approval',
  'codex-0-158-0-trustprompt'
]
const STA_8628_FIXTURES = [
  'codex-0157-plain-ready',
  'codex-0157-effort-override-embedded-warning',
  'codex-0157-config-override-embedded-warning',
  'codex-0157-no-daemon-effort-override'
]

const BUSY_STATUS_RE = /to interrupt\)/
const EMPTY_COMPOSER_RE = /^› ask codex to do anything\s*$/m
const HEADER_LOADING_RE = /(?:model|directory):\s+loading|^\s*loading\s*$/m
const DIALOG_RE =
  /update available|do you trust|trust this folder|would you like to run|press enter to confirm|enter continue/

function screenOf(frame: TranscriptReplayFrame): string {
  return frame.screenLines.join('\n').toLowerCase()
}

async function collectFrames(
  data: string | readonly string[],
  cols = 120,
  rows = 40
): Promise<TranscriptReplayFrame[]> {
  const frames: TranscriptReplayFrame[] = []
  for await (const frame of replayTranscript(data, cols, rows)) {
    frames.push(frame)
  }
  return frames
}

describe('Codex composer ready screen, frame by frame', () => {
  it.each([...SETTLED_IDLE_FIXTURES, ...DIALOG_FIXTURES])(
    '%s: never ready while loading, mid-turn, or under a drawn dialog',
    async (name) => {
      const seen = { loading: 0, busy: 0, dialog: 0 }
      for (const frame of await collectFrames(readRuntimeFixture(name))) {
        const screen = screenOf(frame)
        // Why only once the composer is gone: a half-drawn dialog keeps it for a few frames,
        // which quiescence absorbs; a drawn dialog replaces it.
        const kind = HEADER_LOADING_RE.test(screen)
          ? 'loading'
          : BUSY_STATUS_RE.test(screen)
            ? 'busy'
            : DIALOG_RE.test(screen) && !EMPTY_COMPOSER_RE.test(screen)
              ? 'dialog'
              : null
        if (kind) {
          seen[kind] += 1
          expect({ kind, ready: isCodexComposerReadyScreen(screenOf(frame)) }).toEqual({
            kind,
            ready: false
          })
        }
      }
      // Presence preconditions: each fixture exercises the states it was recorded for.
      expect(seen.loading).toBeGreaterThan(0)
      if (DIALOG_FIXTURES.includes(name)) {
        expect(seen.dialog).toBeGreaterThan(0)
      } else {
        expect(seen.busy).toBeGreaterThan(0)
      }
    },
    30_000
  )

  it.each([...SETTLED_IDLE_FIXTURES, ...STA_8628_FIXTURES])(
    '%s: ready on the final idle screen',
    async (name) => {
      const frames = await collectFrames(readRuntimeFixture(name))
      expect(isCodexComposerReadyScreen(screenOf(frames.at(-1)!))).toBe(true)
    }
  )

  it.each(DIALOG_FIXTURES)('%s: not ready while the dialog owns the screen', async (name) => {
    const frames = await collectFrames(readRuntimeFixture(name))
    expect(isCodexComposerReadyScreen(screenOf(frames.at(-1)!))).toBe(false)
  })

  it('is not ready without a live screen', () => {
    expect(isQuietReadyScreenBody('', 'codex', () => null)).toBe(false)
  })

  it('reads the placeholder only as the composer line, not quoted mid-line', () => {
    const quoted = ['$ grep placeholder notes.txt', 'the box says › Ask Codex to do anything', '$']
    expect(isQuietReadyScreenBody('', 'codex', () => quoted)).toBe(false)
  })

  it('reads the busy row only above the composer, not a status row quoted in the answer', () => {
    const screenLines = [
      '>_ OpenAI Codex (v0.158.0)',
      '   ~/repo',
      '',
      '› what does the status row look like mid-turn?',
      '',
      '• It reads like this:',
      '',
      '  • Working (0s • esc to interrupt)',
      '',
      '  The timer counts up until the turn ends, and the row',
      '  disappears once the answer is complete.',
      '',
      '› Ask Codex to do anything',
      '',
      '  gpt-5.6-sol medium · ~/repo',
      '  ? for shortcuts'
    ]
    expect(isQuietReadyScreenBody('', 'codex', () => screenLines)).toBe(true)
    const composer = screenLines.indexOf('› Ask Codex to do anything')
    const busy = [
      ...screenLines.slice(0, composer),
      '• Working (3s • esc to interrupt)',
      '  └ Tip: start a fresh idea with /new',
      '',
      ...screenLines.slice(composer)
    ]
    expect(isQuietReadyScreenBody('', 'codex', () => busy)).toBe(false)
  })

  it("reads 0.158's turn timestamp above the composer as the end of a quoted status row", () => {
    // Live 0.158 screen after a worker answered with a status row verbatim (STA-8834).
    const screenLines = [
      '  === TASK ===',
      '  Reply with exactly this line and nothing else: • Working (0s • esc to interrupt) — then call worker_done.',
      '• • Working (0s • esc to interrupt)',
      '• Ran orca-dev orchestration send --from term_f496fcd2-a874-4fa6-a9bd-550a515ac928 --dispatch-capability dcap_PTgPpvf-B…',
      '  └ Sent msg_ff7be3f25d7e',
      '    + Show details',
      '• • Working (0s • esc to interrupt)',
      '  11:15 PM',
      '› Ask Codex to do anything',
      '  GPT-6-Sol medium · ~/orca-lanes/sta8834/live3/scratch · Report task outcome',
      '  ? for shortcuts'
    ]
    expect(isQuietReadyScreenBody('', 'codex', () => screenLines)).toBe(true)
  })

  it('settles a quiet composer under an answer asking "Would you like to proceed?"', () => {
    const screenLines = [
      '>_ OpenAI Codex (v0.158.0)',
      '   ~/repo',
      '',
      '› tidy the README',
      '',
      '• Done. Would you like to proceed with the changelog too?',
      '',
      '› Ask Codex to do anything',
      '',
      '  ? for shortcuts'
    ]
    const waitText = screenLines.join('\n')
    const verdict = evaluateTuiIdle({
      record: { lastAgentStatus: null, lastOutputAt: 0, lastOscTitle: null },
      readTailBlockedReason: () => detectTerminalWaitBlockedReason(waitText),
      readPositiveBodyEvidence: () =>
        isKnownReadyPromptBody(waitText, 'codex', () => screenLines, true),
      readQuietReadyBodyEvidence: () =>
        isQuietReadyScreenBody(waitText, 'codex', () => screenLines),
      agent: 'codex',
      readAgentRuleVerdict: () => null,
      readScreenInputVeto: () => null,
      titleObservedAtEpochMs: null,
      firstPartyStatus: null,
      quiescenceMs: QUIESCENCE_MS
    })
    expect(verdict.kind).toBe('ready-strong')
  })
})

type Timing = { promptSentAtMs: number; chunks: [number, number][] }

function readTimedFixture(name: string): { chunks: string[]; times: number[]; promptAt: number } {
  const data = readRuntimeFixture(name)
  const timing: Timing = JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', `${name}.timing.json`), 'utf8')
  )
  const chunks: string[] = []
  let offset = 0
  for (const [, length] of timing.chunks) {
    chunks.push(data.slice(offset, offset + length))
    offset += length
  }
  expect(offset).toBe(data.length)
  return { chunks, times: timing.chunks.map(([at]) => at), promptAt: timing.promptSentAtMs }
}

describe('the quiet lane over recorded chunk timing (default animations)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(TIMED_FIXTURES)(
    '%s: never settles mid-turn, and settles once the finished turn is quiet',
    async (name) => {
      const { chunks, times, promptAt } = readTimedFixture(name)
      const frames = await collectFrames(chunks)
      // Why after the replay: the emulator's write flush runs on real timers.
      vi.useFakeTimers()
      const lastBusy = frames.findLastIndex((frame) => BUSY_STATUS_RE.test(screenOf(frame)))
      const firstTurnChunk = times.findIndex((at) => at >= promptAt)
      expect(lastBusy).toBeGreaterThan(firstTurnChunk)
      // The latest moment each frame stays on screen: just before the next chunk lands.
      const settlesAt = (index: number, now: number): boolean => {
        vi.setSystemTime(now)
        return hasQuietReadyScreen(
          { lastAgentStatus: null, lastOutputAt: times[index]!, lastOscTitle: null },
          'codex',
          () =>
            isQuietReadyScreenBody(
              frames[index]!.waitText,
              'codex',
              () => frames[index]!.screenLines
            ),
          QUIESCENCE_MS
        )
      }
      let readyBodyMidTurn = 0
      for (let index = firstTurnChunk; index <= lastBusy; index += 1) {
        if (isCodexComposerReadyScreen(screenOf(frames[index]!))) {
          readyBodyMidTurn += 1
        }
        expect({ index, settles: settlesAt(index, times[index + 1]! - 1) }).toEqual({
          index,
          settles: false
        })
      }
      // Presence precondition: the body alone does show mid-turn, so quiescence is load-bearing.
      expect(readyBodyMidTurn).toBeGreaterThan(0)
      const last = frames.length - 1
      // Why +1: the fake clock keeps whole milliseconds; the recorded times do not.
      expect(settlesAt(last, times[last]! + QUIESCENCE_MS + 1)).toBe(true)
    },
    120_000
  )
})

describe('a busy 0.150-0.157 pane whose header stays in the tail', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['codex-0-155-1-timed-turn', 'codex-0-157-1-timed-sleep-turn'])(
    '%s: never settles tui-idle mid-turn, and settles once the finished turn is quiet',
    async (name) => {
      const { chunks, times, promptAt } = readTimedFixture(name)
      const frames = await collectFrames(chunks)
      vi.useFakeTimers()
      const verdictAt = (index: number, now: number) => {
        vi.setSystemTime(now)
        const { waitText, screenLines } = frames[index]!
        return evaluateTuiIdle({
          record: { lastAgentStatus: null, lastOutputAt: times[index]!, lastOscTitle: null },
          readTailBlockedReason: () => detectTerminalWaitBlockedReason(waitText),
          readPositiveBodyEvidence: () =>
            isKnownReadyPromptBody(waitText, 'codex', () => screenLines, true),
          readQuietReadyBodyEvidence: () =>
            isQuietReadyScreenBody(waitText, 'codex', () => screenLines),
          agent: 'codex',
          readAgentRuleVerdict: () => null,
          readScreenInputVeto: () => null,
          titleObservedAtEpochMs: null,
          firstPartyStatus: null,
          quiescenceMs: QUIESCENCE_MS
        })
      }
      const lastBusy = frames.findLastIndex((frame) => BUSY_STATUS_RE.test(screenOf(frame)))
      const firstTurnChunk = times.findIndex((at) => at >= promptAt)
      let headerMidTurn = 0
      for (let index = firstTurnChunk; index <= lastBusy; index += 1) {
        if (isKnownReadyPromptPreview(frames[index]!.waitText)) {
          headerMidTurn += 1
        }
        const settles = isTuiIdleReadyVerdict(verdictAt(index, times[index + 1]! - 1))
        expect({ index, settles }).toEqual({ index, settles: false })
      }
      // Presence precondition: the ready header is in the tail mid-turn, so the fix is load-bearing.
      expect(headerMidTurn).toBeGreaterThan(0)
      const last = frames.length - 1
      expect(verdictAt(last, times[last]!).kind).toBe('pending')
      expect(verdictAt(last, times[last]! + QUIESCENCE_MS + 1).kind).toBe('ready-strong')
    },
    120_000
  )

  const header = [
    '│ >_ OpenAI Codex (v0.157.1)                               │',
    '│ model:       GPT-6-Sol high   /model to change           │',
    '│ directory:   ~/repo/app                                  │'
  ]

  it('reads the header as tier-1 evidence only for a pane with no output clock', () => {
    const waitText = header.join('\n')
    expect(isKnownReadyPromptBody(waitText, 'codex', () => header, true)).toBe(false)
    expect(isKnownReadyPromptBody(waitText, 'codex', () => header, false)).toBe(true)
    expect(isKnownReadyPromptBody(waitText, null, () => header, true)).toBe(true)
  })

  // Why: a restored or reattached pane has no lastOutputAt, so the quiet lane can never fire.
  const NOW = 60_000
  it.each([
    [null, 'ready-strong'],
    [0, 'ready-strong'],
    [NOW - 1_000, 'pending']
  ] as const)(
    'a codex pane whose lastOutputAt is %s reads its header as %s',
    (lastOutputAt, kind) => {
      vi.useFakeTimers()
      vi.setSystemTime(NOW)
      const waitText = header.join('\n')
      const record = { lastAgentStatus: null, lastOutputAt, lastOscTitle: null }
      const verdict = evaluateTuiIdle({
        record,
        readTailBlockedReason: () => detectTerminalWaitBlockedReason(waitText),
        readPositiveBodyEvidence: () =>
          isKnownReadyPromptBody(waitText, 'codex', () => header, record.lastOutputAt !== null),
        readQuietReadyBodyEvidence: () => isQuietReadyScreenBody(waitText, 'codex', () => header),
        agent: 'codex',
        readAgentRuleVerdict: () => null,
        readScreenInputVeto: () => null,
        titleObservedAtEpochMs: null,
        firstPartyStatus: null,
        quiescenceMs: QUIESCENCE_MS
      })
      expect(verdict.kind).toBe(kind)
    }
  )
})

describe('reading the live screen never removes quiet-lane readiness', () => {
  const records = [
    { lastAgentStatus: null, lastOutputAt: 0, lastOscTitle: null },
    { lastAgentStatus: 'idle' as const, lastOutputAt: 0, lastOscTitle: 'codex' },
    { lastAgentStatus: 'working' as const, lastOutputAt: 0, lastOscTitle: '⠋ repo' }
  ]
  describe.each([
    [120, 40],
    [80, 24]
  ])('at %ix%i', (cols, rows) => {
    it.each([...SETTLED_IDLE_FIXTURES, ...DIALOG_FIXTURES, ...STA_8628_FIXTURES])(
      '%s',
      async (name) => {
        for (const frame of await collectFrames(readRuntimeFixture(name), cols, rows)) {
          for (const agent of ['codex', null] as const) {
            const base = {
              readTailBlockedReason: () => detectTerminalWaitBlockedReason(frame.waitText),
              readPositiveBodyEvidence: () =>
                isKnownReadyPromptBody(frame.waitText, agent, () => frame.screenLines, true),
              agent,
              readAgentRuleVerdict: () => null,
              readScreenInputVeto: () => null,
              titleObservedAtEpochMs: null,
              firstPartyStatus: null,
              quiescenceMs: QUIESCENCE_MS
            } satisfies Omit<TuiIdleEvaluationInput, 'record' | 'readQuietReadyBodyEvidence'>
            for (const record of records) {
              const before = evaluateTuiIdle({
                ...base,
                record,
                // Why a withheld screen: isolates what the live screen adds to the quiet lane.
                readQuietReadyBodyEvidence: () =>
                  isQuietReadyScreenBody(frame.waitText, agent, () => null)
              })
              const after = evaluateTuiIdle({
                ...base,
                record,
                readQuietReadyBodyEvidence: () =>
                  isQuietReadyScreenBody(frame.waitText, agent, () => frame.screenLines)
              })
              if (isTuiIdleReadyVerdict(before)) {
                expect(isTuiIdleReadyVerdict(after)).toBe(true)
              }
            }
          }
        }
      },
      60_000
    )
  })
})

describe('agent gate', () => {
  const placeholderScreen = ['› Ask Codex to do anything', '  ? for shortcuts']

  it("never reads another agent's screen, even one showing Codex's placeholder", () => {
    const readScreenLines = vi.fn(() => placeholderScreen)
    for (const agent of ['claude', 'muse', 'gemini'] as const) {
      expect(isQuietReadyScreenBody('', agent, readScreenLines)).toBe(false)
    }
    expect(readScreenLines).not.toHaveBeenCalled()
    expect(isQuietReadyScreenBody('', 'codex', readScreenLines)).toBe(true)
  })

  it('leaves an agent-unknown pane showing a cat-ed Codex transcript pending', () => {
    const catted = ['$ cat session.log', '› Ask Codex to do anything', '  ? for shortcuts', '$ ']
    const readScreenLines = vi.fn(() => catted)
    expect(isQuietReadyScreenBody(catted.join('\n'), null, readScreenLines)).toBe(false)
    expect(readScreenLines).not.toHaveBeenCalled()
    expect(isQuietReadyScreenBody('', 'codex', readScreenLines)).toBe(true)
  })
})

describe('through the runtime', () => {
  // Why 0.158 alone: its header carries no `model:`, so only this lane settles it.
  const CODEX_0158 = 'codex-0-158-0-timed-turn'
  async function pane(name: string, launchAgent: TuiAgent, size?: { cols: number; rows: number }) {
    const created = await createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: launchAgent,
      launchAgent,
      data: readRuntimeFixture(name),
      size
    })
    await created.runtime.readTerminal(created.handle, { screen: true })
    return created
  }

  // Why 8s: quiescence (3s) plus the 2s poll re-reading the grid.
  it('codex 0.158: a tui-idle wait settles once the composer is quiet', async () => {
    const { runtime, handle } = await pane(CODEX_0158, 'codex', { cols: 120, rows: 40 })
    await expect(waitForTranscriptIdle({ runtime, handle }, 8_000)).resolves.toMatchObject({
      condition: 'tui-idle',
      satisfied: true
    })
  }, 15_000)

  it('keeps a Claude pane showing the same screen pending', async () => {
    const { runtime, handle } = await pane(CODEX_0158, 'claude', {
      cols: 120,
      rows: 40
    })
    await expect(waitForTranscriptIdle({ runtime, handle }, 6_000)).rejects.toThrow(/timeout/)
  }, 15_000)
})
