import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import { createTranscriptPane, waitForTranscriptIdle } from './agent-transcript-pane-test-harness'
import {
  readRuntimeFixture,
  readTimedRuntimeFixture,
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
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('Codex quiet ready screen', () => {
  const QUIESCENCE_MS = 3000

  // codex-cli 120x40 captures (per-fixture .meta.json); STA-8834. 0.157 uses STA-8628 captures.
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
      '%s: rejects loading, busy and dialog frames and reads the final composer state',
      async (name) => {
        const seen = { loading: 0, busy: 0, dialog: 0 }
        const frames = await collectFrames(readRuntimeFixture(name))
        for (const frame of frames) {
          const screen = screenOf(frame)
          // Half-painted dialogs retain the composer briefly; quiescence absorbs those frames.
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
        expect(seen.loading).toBeGreaterThan(0)
        if (DIALOG_FIXTURES.includes(name)) {
          expect(seen.dialog).toBeGreaterThan(0)
        } else {
          expect(seen.busy).toBeGreaterThan(0)
        }
        expect(isCodexComposerReadyScreen(screenOf(frames.at(-1)!))).toBe(
          !DIALOG_FIXTURES.includes(name)
        )
      },
      30_000
    )

    it.each(STA_8628_FIXTURES)('%s: ready on the final idle screen', async (name) => {
      const frames = await collectFrames(readRuntimeFixture(name))
      expect(isCodexComposerReadyScreen(screenOf(frames.at(-1)!))).toBe(true)
    })

    it('is not ready without a live screen', () => {
      expect(isQuietReadyScreenBody('', 'codex', () => null)).toBe(false)
    })

    it('reads the placeholder only as the composer line, not quoted mid-line', () => {
      const quoted = [
        '$ grep placeholder notes.txt',
        'the box says › Ask Codex to do anything',
        '$'
      ]
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

  describe('the quiet lane over recorded chunk timing (default animations)', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it.each([
      { name: 'codex-0-155-1-timed-turn', composer: true, header: true },
      { name: 'codex-0-158-0-timed-turn', composer: true, header: false },
      { name: 'codex-0-157-1-timed-sleep-turn', composer: false, header: true }
    ])(
      '$name: never settles mid-turn, and settles once the finished turn is quiet',
      async ({ name, composer, header }) => {
        const { chunks, times, promptSentAtMs } = readTimedRuntimeFixture(name)
        if (promptSentAtMs === undefined) {
          throw new Error(`${name}.timing.json is missing promptSentAtMs`)
        }
        const frames = await collectFrames(chunks)
        vi.useFakeTimers()
        const lastBusy = frames.findLastIndex((frame) => BUSY_STATUS_RE.test(screenOf(frame)))
        const firstTurnChunk = times.findIndex((at) => at >= promptSentAtMs)
        if (composer) {
          expect(lastBusy).toBeGreaterThan(firstTurnChunk)
        }
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
        let readyBodyMidTurn = 0
        let headerMidTurn = 0
        for (let index = firstTurnChunk; index <= lastBusy; index += 1) {
          if (composer) {
            if (isCodexComposerReadyScreen(screenOf(frames[index]!))) {
              readyBodyMidTurn += 1
            }
            expect({ index, settles: settlesAt(index, times[index + 1]! - 1) }).toEqual({
              index,
              settles: false
            })
          }
          if (header) {
            if (isKnownReadyPromptPreview(frames[index]!.waitText)) {
              headerMidTurn += 1
            }
            const settles = isTuiIdleReadyVerdict(verdictAt(index, times[index + 1]! - 1))
            expect({ index, settles }).toEqual({ index, settles: false })
          }
        }
        const last = frames.length - 1
        if (composer) {
          // Mid-turn composers still require quiet output.
          expect(readyBodyMidTurn).toBeGreaterThan(0)
          // Recorded sub-millisecond times need +1 under the integer fake clock.
          expect(settlesAt(last, times[last]! + QUIESCENCE_MS + 1)).toBe(true)
        }
        if (header) {
          expect(headerMidTurn).toBeGreaterThan(0)
          expect(verdictAt(last, times[last]!).kind).toBe('pending')
          expect(verdictAt(last, times[last]! + QUIESCENCE_MS + 1).kind).toBe('ready-strong')
        }
      },
      120_000
    )
  })

  describe('a busy 0.150-0.157 pane whose header stays in the tail', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

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

    // Restored/reattached panes lack lastOutputAt and cannot settle through the quiet clock.
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
          const comparisons = { codex: 0, unknown: 0 }
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
                  // Withhold screen evidence to isolate its contribution.
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
                  comparisons[agent ?? 'unknown'] += 1
                  expect(isTuiIdleReadyVerdict(after)).toBe(true)
                }
              }
            }
          }
          expect(comparisons.codex).toBeGreaterThan(0)
          expect(comparisons.unknown).toBeGreaterThan(0)
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
    // 0.158 has no model: header, so only composer evidence settles this lane.
    const CODEX_0158 = 'codex-0-158-0-timed-turn'
    async function pane(
      name: string,
      launchAgent: TuiAgent,
      size?: { cols: number; rows: number }
    ) {
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

    // Allow 3s quiescence and the 2s grid poll after transcript replay.
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
})

describe('Codex startup dialogs', () => {
  type StartupDialog = {
    name: string
    reason: RuntimeTerminalWaitBlockedReason
    heading: string
    keyRow: string
  }

  // Fresh CODEX_HOME 0.157/0.158 captures (per-fixture metadata): dialogs own Enter without old Press enter wording.
  const DIALOGS: StartupDialog[] = [
    {
      // Recorded separately on 0.157.1 (STA-8834).
      name: 'codex-0-157-1-update-dialog',
      reason: 'agent-update-prompt',
      heading: 'Update available ·',
      keyRow: 'enter continue · esc skip'
    },
    {
      name: 'codex-0157-update-available-dialog',
      reason: 'agent-update-prompt',
      heading: 'Update available ·',
      keyRow: 'enter continue · esc skip'
    },
    {
      name: 'codex-0158-update-available-dialog',
      reason: 'agent-update-prompt',
      heading: 'Update available ·',
      keyRow: 'enter continue · esc skip'
    },
    {
      name: 'codex-0157-hooks-review-dialog',
      reason: 'agent-hooks-review-prompt',
      heading: 'Hooks need review',
      keyRow: 'enter confirm · esc skip'
    },
    {
      name: 'codex-0158-hooks-review-dialog',
      reason: 'agent-hooks-review-prompt',
      heading: 'Hooks need review',
      keyRow: 'enter confirm · esc skip'
    },
    {
      name: 'codex-0157-model-retired-dialog',
      reason: 'codex-model-migration-prompt',
      heading: 'is no longer available',
      keyRow: 'enter/esc continue · ctrl+c quit'
    },
    {
      name: 'codex-0158-model-retired-dialog',
      reason: 'codex-model-migration-prompt',
      heading: 'is no longer offered',
      keyRow: 'enter/esc continue · ctrl+c quit'
    },
    {
      name: 'codex-0158-model-announcement-dialog',
      reason: 'codex-model-migration-prompt',
      heading: 'Try new model',
      keyRow: 'enter/esc confirm · ctrl+c quit'
    }
  ]
  const DIALOGS_0158 = DIALOGS.filter((dialog) => dialog.name.startsWith('codex-0158-'))
  const LIVE_CHAT_FIXTURES = [
    'codex-0157-plain-ready',
    'codex-0157-effort-override-embedded-warning',
    'codex-0157-config-override-embedded-warning',
    'codex-0157-no-daemon-effort-override',
    'codex-0157-fresh-home-daemon-install',
    'codex-0158-fresh-home-greeting'
  ]

  function screenText(frame: TranscriptReplayFrame): string {
    return frame.screenLines.join('\n')
  }

  async function lastFrame(data: string): Promise<TranscriptReplayFrame | null> {
    let last: TranscriptReplayFrame | null = null
    for await (const frame of replayTranscript(data, 120, 40)) {
      last = frame
    }
    return last
  }

  // No capture spans dialog dismissal; 0.158 greeting paints stand in for the full-cell repaint.
  function answered(name: string): string {
    const greeting = readRuntimeFixture('codex-0158-fresh-home-greeting')
    return readRuntimeFixture(name) + greeting.slice(greeting.indexOf('\x1b[?2026h'))
  }

  describe('Codex 0.157/0.158 startup dialogs from captured bytes', () => {
    it.each(DIALOGS)(
      '$name: reports $reason from its key row on, and never reads ready while it is up',
      async ({ name, reason, heading, keyRow }) => {
        let headingFrames = 0
        let keyRowFrames = 0
        for await (const frame of replayTranscript(readRuntimeFixture(name), 120, 40)) {
          const screen = screenText(frame)
          if (screen.includes(heading)) {
            headingFrames += 1
            expect(isQuietReadyScreenBody(frame.waitText, 'codex', () => frame.screenLines)).toBe(
              false
            )
            expect(
              isKnownReadyPromptBody(frame.waitText, null, () => frame.screenLines, true)
            ).toBe(false)
          }
          if (keyRowFrames > 0 || screen.includes(keyRow)) {
            keyRowFrames += 1
            expect(detectTerminalWaitBlockedReason(frame.waitText)).toBe(reason)
          }
        }
        expect(headingFrames).toBeGreaterThan(0)
        expect(keyRowFrames).toBeGreaterThan(0)
      }
    )

    it.each(DIALOGS_0158)(
      '$name: stops reporting once Codex repaints its chat after it',
      async ({ name, heading }) => {
        const last = await lastFrame(answered(name))
        expect(last?.waitText).toContain(heading.replace(' ·', ''))
        expect(detectTerminalWaitBlockedReason(last?.waitText ?? '')).toBeNull()
      }
    )

    it.each(DIALOGS)(
      '$name: still reports $reason when Codex is relaunched in the same pane and shows it again',
      async ({ name, reason }) => {
        // Quitting a dialog leaves its old copy in scrollback before relaunch.
        const dialog = readRuntimeFixture(name)
        const last = await lastFrame(`${dialog}\x1b[?1049l\r\n% codex\r\n${dialog}`)
        expect(detectTerminalWaitBlockedReason(last?.waitText ?? '')).toBe(reason)
        expect(
          isQuietReadyScreenBody(last?.waitText ?? '', 'codex', () => last?.screenLines ?? null)
        ).toBe(false)
      }
    )

    it.each(LIVE_CHAT_FIXTURES)('%s: a live chat reports no dialog', async (name) => {
      const waitText = (await lastFrame(readRuntimeFixture(name)))?.waitText ?? ''
      expect(detectTerminalWaitBlockedReason(waitText)).toBeNull()
      // Chat can quote dialogs; update notices/footer can contain the separator too.
      const chat = [
        '› is there an update available, and do my hooks need review?',
        '✨ Update available! 0.158.0 -> 0.159.0',
        'Run npm install -g @openai/codex to update.',
        '  gpt-6-astra default · ~/repo',
        '  ← for agents · ? for shortcuts'
      ].join('\n')
      expect(detectTerminalWaitBlockedReason(`${waitText}\n${chat}`)).toBeNull()
    })

    it('does not name a mid-session Codex popup a hooks review', () => {
      // Rate-limit reset popups/pickers use the same confirm/back footer.
      const popup = [
        '  Use this reset?',
        '  1. Yes, use reset  Reset your weekly and 5-hour usage limits.',
        '› 2. No, go back     Choose a different reset',
        '  enter confirm · esc back'
      ].join('\n')
      expect(detectTerminalWaitBlockedReason(popup)).not.toBe('agent-hooks-review-prompt')
    })

    describe('through the runtime', () => {
      it.each(DIALOGS)(
        '$name: stops a tui-idle wait as $reason instead of typing into it',
        async ({ name, reason }) => {
          const { runtime, handle } = await createTranscriptPane({
            paneTitle: 'Terminal',
            foregroundProcess: 'codex',
            launchAgent: 'codex',
            data: readRuntimeFixture(name),
            size: { cols: 120, rows: 40 }
          })
          await expect(
            runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_500 })
          ).resolves.toMatchObject({ satisfied: false, blockedReason: reason })
        },
        15_000
      )
    })
  })
})
