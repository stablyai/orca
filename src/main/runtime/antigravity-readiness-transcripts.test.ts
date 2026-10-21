import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID,
  waitForTranscriptIdle
} from './agent-transcript-pane-test-harness'
import { extractLastOscTitle } from '../../shared/osc-title-extraction'
import {
  finalReplayFrame,
  readRuntimeFixture,
  replayTranscript
} from './agent-transcript-replay-test-harness'
import {
  describeScreenRuledAgentTranscripts,
  readsIdleComposer
} from './screen-ruled-agent-transcript-suite'
import {
  isKnownReadyPromptBody,
  isKnownReadyPromptPreview,
  isQuietReadyScreenBody
} from './terminal-wait-detection'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('Antigravity raw captured readiness', () => {
  /**
   * Pins Antigravity readiness to captured transcripts instead of hand-written fixtures.
   *
   * Five detector attempts were tuned against a five-line screen someone typed from memory, and
   * three of them shipped worse behaviour than the bug they replaced. Nothing here asserts what
   * Antigravity prints: the transcripts do. Six are recorded from a live `agy`; the rest name
   * themselves as skipped until someone can reach them.
   *
   * One case is pinned as a KNOWN DEFECT: the shipped detector refuses a ready screen whose retained
   * tail ends on the error block. That asserts what it does, not what it should.
   */

  const FIXTURE_DIR = join(__dirname, '__fixtures__')
  // Why asymmetric: a ready verdict has to survive the settle window, while a refusal only has to
  // hold for one poll. Keeping the refusal short keeps seven transcripts off the suite's clock.
  const READY_TIMEOUT_MS = 2_000
  const REFUSAL_TIMEOUT_MS = 600
  /** Antigravity's binary, as Orca launches and probes it (`tui-agent-config.ts` detectCmd). */
  const ANTIGRAVITY_COMMAND = 'agy'
  // String.fromCharCode, not a literal: the formatter rewrites an escape sequence into a raw
  // control byte in source, which is unreadable and survives badly in diffs.
  const ESC = String.fromCharCode(27)

  type TranscriptCase = {
    /** Fixture basename; `<name>.txt` under `__fixtures__/`. */
    name: string
    /** Capture group identifier. */
    capture: string
    what: string
    /** What a correct detector must answer. Not what the shipped one answers. */
    expectReady: boolean
    /**
     * Set where the shipped detector contradicts the transcript. The case then runs inverted, so
     * CI pins the defect instead of going permanently red — and flips to failing the moment
     * someone fixes it, which is exactly when these expectations need re-reading.
     */
    knownDefect?: string
  }

  const TRANSCRIPTS: readonly TranscriptCase[] = [
    {
      name: 'antigravity-ready-api-key-gemini-model',
      capture: 'B',
      what: 'ready screen, API-key identity — the account row reads "Gemini API key", not an email',
      expectReady: true
    },
    {
      name: 'antigravity-ready-account-info-hidden',
      capture: 'B',
      what: 'ready screen with AGY_CLI_HIDE_ACCOUNT_INFO=1 — no account row at all',
      expectReady: true
    },
    {
      name: 'antigravity-dialog-trust-workspace',
      capture: 'C',
      what: 'workspace trust dialog owning the screen',
      expectReady: false
    },
    {
      name: 'antigravity-dialog-model-picker',
      capture: 'C',
      what: 'model picker owning the screen',
      expectReady: false
    },
    {
      name: 'antigravity-dialog-command-palette',
      capture: 'C',
      what: 'slash-command palette owning the screen',
      expectReady: false
    },
    {
      name: 'antigravity-busy-mid-turn',
      capture: 'E',
      what: 'mid-turn, spinner live — the pane is working, not waiting for a prompt',
      expectReady: false
    },
    {
      // Expected ready because the turn is over and the composer is back on screen. The captured
      // turn ends in a backend error, which is the only ending this account's key can produce.
      name: 'antigravity-busy-turn-ended',
      capture: 'E',
      what: 'the turn has ended and the composer has returned, process still alive',
      expectReady: true,
      knownDefect: 'refused: the retained tail ends on the error block, with no composer row in it'
    },
    {
      name: 'antigravity-dialog-dismissed',
      capture: 'D',
      what: 'the screen immediately after the model picker is dismissed',
      expectReady: true
    },
    // Not captured: this machine's agy has no OAuth session and offers only Gemini models, and
    // reaching the rest would mean signing the operator out or deleting their config.
    {
      name: 'antigravity-ready-business-non-gemini',
      capture: 'A',
      what: 'ready screen, Business account, non-Gemini model',
      expectReady: true
    },
    {
      name: 'antigravity-dialog-sign-in',
      capture: 'C',
      what: 'sign-in dialog owning the screen',
      expectReady: false
    },
    {
      name: 'antigravity-dialog-theme-picker',
      capture: 'C',
      what: 'theme picker owning the screen',
      expectReady: false
    },
    {
      name: 'antigravity-dialog-privacy-notice',
      capture: 'C',
      what: 'privacy notice owning the screen',
      expectReady: false
    },
    {
      name: 'antigravity-dialog-update-banner',
      capture: 'C',
      what: 'update banner owning the screen',
      expectReady: false
    }
  ]

  function fixturePath(name: string): string {
    return join(FIXTURE_DIR, `${name}.txt`)
  }

  /**
   * A `tui-idle` wait ends three ways, and only one of them is readiness: it resolves satisfied, it
   * resolves unsatisfied with a blocked reason, or it rejects with `timeout` because nothing ever
   * looked ready. The orchestrator treats the last two identically — no prompt is delivered — so
   * they are both `ready: false` here. This is the shape `worker-start` sees.
   */
  async function readinessVerdict(
    transcript: string,
    timeoutMs: number
  ): Promise<{ ready: boolean; blockedReason: unknown; outcome: string }> {
    const { runtime, handle } = await createTranscriptPane({
      // Why the transcript's own title: every attempt guessed at Antigravity's title. A raw
      // capture carries the OSC bytes, so the pane wears whatever the CLI actually set.
      paneTitle: extractLastOscTitle(transcript) ?? ANTIGRAVITY_COMMAND,
      foregroundProcess: ANTIGRAVITY_COMMAND,
      data: transcript
    })
    await runtime.readTerminal(handle, { screen: true })
    try {
      const result = await waitForTranscriptIdle({ runtime, handle }, timeoutMs)
      return {
        ready: result.satisfied === true,
        blockedReason: result.blockedReason ?? null,
        outcome: result.satisfied === true ? 'satisfied' : 'unsatisfied'
      }
    } catch (error) {
      return { ready: false, blockedReason: null, outcome: `rejected: ${String(error)}` }
    }
  }

  describe('Antigravity readiness, decided by captured transcripts', () => {
    for (const transcript of TRANSCRIPTS) {
      const path = fixturePath(transcript.name)
      const captured = existsSync(path)
      const label = `capture ${transcript.capture}: ${transcript.what}`

      // A pinned defect asserts what the detector DOES, so CI is honest rather than permanently
      // red; fixing the detector flips this case to failing, which is when these expectations
      // need re-reading. The correct answer stays in `expectReady` and in the test's name.
      const shipped =
        transcript.knownDefect === undefined ? transcript.expectReady : !transcript.expectReady
      const verdictName =
        transcript.knownDefect === undefined
          ? `${label} → ${transcript.expectReady ? 'ready' : 'not ready'}`
          : `${label} → must be ${transcript.expectReady ? 'ready' : 'not ready'}; KNOWN DEFECT, ${transcript.knownDefect}`

      it.skipIf(!captured)(
        verdictName,
        async () => {
          // A refusal only has to hold for one poll; a ready verdict has to survive the settle
          // window. Keeping the refusal short keeps eleven transcripts off the suite's clock.
          const verdict = await readinessVerdict(
            readFileSync(path, 'utf8'),
            transcript.expectReady ? READY_TIMEOUT_MS : REFUSAL_TIMEOUT_MS
          )
          // A silent dialog carries no blocked-signal wording, so the assertion is only that Orca
          // does not call the pane ready and type a prompt into a dialog that owns the screen.
          expect({ ready: verdict.ready, outcome: verdict.outcome }).toMatchObject({
            ready: shipped
          })
        },
        READY_TIMEOUT_MS + 10_000
      )

      it.skipIf(!captured)(`${label} was captured raw, not pasted from a rendered screen`, () => {
        const text = readFileSync(path, 'utf8')
        // Why: a transcript with no escape bytes went through a terminal's renderer and a
        // human's clipboard. It cannot answer what the caret or chrome looked like.
        expect(text).toContain(ESC)
      })
    }
  })
})

describe('Antigravity screen ruled readiness', () => {
  // agy 1.2.14 on macOS, AGY_CLI_HIDE_ACCOUNT_INFO=1 (see each .meta.json); STA-8741.
  const at120x40 = (name: string, what: string) => ({ name, what, cols: 120, rows: 40 })
  const READY = [
    at120x40('antigravity-1-2-14-ready', 'settled startup'),
    at120x40('antigravity-1-2-14-ready-accept-edits', '--mode accept-edits'),
    at120x40('antigravity-1-2-14-ready-plan', '--mode plan'),
    { name: 'antigravity-1-2-14-ready-80x24', what: 'settled startup', cols: 80, rows: 24 },
    at120x40('antigravity-1-2-14-picker-dismissed', '/model closed with Esc'),
    at120x40('antigravity-1-2-14-turn-ended', 'a turn has ended')
  ]
  const NOT_READY = [
    at120x40('antigravity-1-2-14-model-picker', '/model picker open'),
    at120x40('antigravity-1-2-14-command-palette', 'slash palette open'),
    at120x40('antigravity-1-2-14-busy-thinking', 'spinner before the answer'),
    at120x40('antigravity-1-2-14-busy-streaming', 'answer streaming'),
    at120x40('antigravity-1-2-14-trust-dialog', 'workspace trust dialog'),
    at120x40('antigravity-1-2-14-draft', 'unsent text in the composer')
  ]

  describe('Antigravity 1.2.14 readiness from captured bytes', () => {
    describeScreenRuledAgentTranscripts({
      agent: 'antigravity',
      foregroundProcess: 'agy',
      ready: READY,
      notReady: NOT_READY,
      // Why these: the line-folded text rule reads only these ready screens.
      readyWithoutScreen: [
        'antigravity-1-2-14-ready',
        'antigravity-1-2-14-ready-80x24',
        'antigravity-1-2-14-picker-dismissed'
      ]
    })

    it.each([
      'antigravity-1-2-14-ready-accept-edits',
      'antigravity-1-2-14-ready-plan',
      'antigravity-1-2-14-turn-ended'
    ])('%s: the line-folded text rule alone misses this ready screen', async (name) => {
      const { waitText } = await finalReplayFrame(name, 120, 40)
      expect(isKnownReadyPromptPreview(waitText)).toBe(false)
    })

    it('does not let the text rules overrule a screen that refused', async () => {
      const { waitText } = await finalReplayFrame('antigravity-1-2-14-picker-dismissed', 120, 40)
      const { ruledScreenLines } = await finalReplayFrame(
        'antigravity-1-2-14-model-picker',
        120,
        40
      )
      // Presence precondition: the text alone would say ready.
      expect(isKnownReadyPromptPreview(waitText)).toBe(true)
      expect(isQuietReadyScreenBody(waitText, 'antigravity', () => ruledScreenLines)).toBe(false)
      expect(isKnownReadyPromptBody(waitText, 'antigravity', () => ruledScreenLines, false)).toBe(
        false
      )
    })

    // Why a caret rule is not enough: agy keeps the bare composer caret painted through both.
    it.each(['antigravity-1-2-14-busy-streaming', 'antigravity-1-2-14-model-picker'])(
      '%s: the bare caret is still on screen',
      async (name) => {
        const { ruledScreenLines } = await finalReplayFrame(name, 120, 40)
        expect(ruledScreenLines.some((line) => line.trim() === '>')).toBe(true)
      }
    )

    // Why a clocked pane waits for quiet: the submit repaint clears the composer a moment before
    // it swaps `? for shortcuts` for `esc to cancel`.
    it('reads a submit repaint as ready for a moment mid-turn', async () => {
      const data = readRuntimeFixture('antigravity-1-2-14-turn-ended')
      let submitted = false
      let answered = false
      let readyMidTurn = 0
      for await (const { ruledScreenLines } of replayTranscript(data, 120, 40)) {
        submitted ||= ruledScreenLines.some((line) => line.startsWith('> Without using any tools'))
        answered ||= ruledScreenLines.some((line) => line.trim() === 'ok')
        if (submitted && !answered && readsIdleComposer('antigravity', ruledScreenLines)) {
          readyMidTurn += 1
        }
      }
      expect(submitted && answered).toBe(true)
      expect(readyMidTurn).toBeGreaterThan(0)
    })

    // Why: a shell auto-title names the process; before the screen decided, that name-only idle
    // title settled a pane whose picker carries no blocked wording.
    it('does not settle an open model picker from a name-only `agy` title', async () => {
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'agy',
        foregroundProcess: 'agy',
        launchAgent: 'antigravity',
        data: `${String.fromCharCode(27)}]0;agy${String.fromCharCode(7)}${readRuntimeFixture('antigravity-1-2-14-model-picker')}`,
        size: { cols: 120, rows: 40 }
      })
      await runtime.readTerminal(handle, { screen: true })
      await expect(waitForTranscriptIdle({ runtime, handle }, 5_000)).rejects.toThrow(/timeout/)
    }, 15_000)

    // Why this recording: only the screen reads it ready, so settling proves the grid is trusted.
    it('trusts a reflowed grid again once a PTY resize off it repaints the TUI', async () => {
      const turnEnded = readRuntimeFixture('antigravity-1-2-14-turn-ended')
      const options = {
        paneTitle: 'Terminal',
        foregroundProcess: 'agy',
        launchAgent: 'antigravity' as const,
        data: turnEnded,
        size: { cols: 100, rows: 30 }
      }
      const { runtime, handle } = await createTranscriptPane(options)
      const resizePty = (cols: number, rows: number) => {
        options.size = { cols, rows }
        runtime.onExternalPtyResize(TRANSCRIPT_PANE_PTY_ID, cols, rows)
      }
      const settles = async () =>
        (
          await waitForTranscriptIdle({ runtime, handle }, 5_000).catch(() => ({
            satisfied: false
          }))
        ).satisfied
      options.size = { cols: 120, rows: 40 }
      runtime.reflowHeadlessTerminalToPtyGrid(TRANSCRIPT_PANE_PTY_ID, 120, 40)
      await runtime.readTerminal(handle, { screen: true })
      expect(await settles()).toBe(false)
      resizePty(121, 40)
      resizePty(120, 40)
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, turnEnded, Date.now())
      await runtime.readTerminal(handle, { screen: true })
      expect(await settles()).toBe(true)
    }, 45_000)
  })
})
