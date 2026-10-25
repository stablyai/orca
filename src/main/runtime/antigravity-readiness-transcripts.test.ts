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
  /** Live PTY transcripts avoid guessed screen fixtures; unavailable captures stay skipped.
   * knownDefect cases pin shipped behavior while expectReady retains the correct result. */

  const FIXTURE_DIR = join(__dirname, '__fixtures__')
  // Ready must survive settling; refusal needs only one poll.
  const READY_TIMEOUT_MS = 2_000
  const REFUSAL_TIMEOUT_MS = 600
  const ANTIGRAVITY_COMMAND = 'agy'
  type TranscriptCase = {
    name: string
    capture: string
    what: string
    /** Correct behavior, including when the shipped detector disagrees. */
    expectReady: boolean
    /** Invert a known defect to pin shipped behavior; a detector fix then forces expectation review. */
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
      // This account's turn ends in a backend error, but its composer is ready.
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
    // Missing captures require changing the operator's account/config; leave them skipped.
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

  /** Blocked and timeout both mean no prompt may be delivered; only satisfied means ready. */
  async function readinessVerdict(
    transcript: string,
    timeoutMs: number
  ): Promise<{ ready: boolean; blockedReason: unknown; outcome: string }> {
    const { runtime, handle } = await createTranscriptPane({
      // Use captured OSC title bytes rather than guessing the CLI title.
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

      // A detector fix flips known-defect expectations and requires review.
      const shipped =
        transcript.knownDefect === undefined ? transcript.expectReady : !transcript.expectReady
      const verdictName =
        transcript.knownDefect === undefined
          ? `${label} → ${transcript.expectReady ? 'ready' : 'not ready'}`
          : `${label} → must be ${transcript.expectReady ? 'ready' : 'not ready'}; KNOWN DEFECT, ${transcript.knownDefect}`

      it.skipIf(!captured)(
        verdictName,
        async () => {
          const verdict = await readinessVerdict(
            readFileSync(path, 'utf8'),
            transcript.expectReady ? READY_TIMEOUT_MS : REFUSAL_TIMEOUT_MS
          )
          // Silent dialogs lack blocker wording; they still must not receive prompts.
          expect({ ready: verdict.ready, outcome: verdict.outcome }).toMatchObject({
            ready: shipped
          })
        },
        READY_TIMEOUT_MS + 10_000
      )
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
      expect(isKnownReadyPromptPreview(waitText)).toBe(true)
      expect(isQuietReadyScreenBody(waitText, 'antigravity', () => ruledScreenLines)).toBe(false)
      expect(isKnownReadyPromptBody(waitText, 'antigravity', () => ruledScreenLines, false)).toBe(
        false
      )
    })

    // agy retains a composer caret while busy and in menus.
    it.each(['antigravity-1-2-14-busy-streaming', 'antigravity-1-2-14-model-picker'])(
      '%s: the bare caret is still on screen',
      async (name) => {
        const { ruledScreenLines } = await finalReplayFrame(name, 120, 40)
        expect(ruledScreenLines.some((line) => line.trim() === '>')).toBe(true)
      }
    )

    // Submit briefly clears the composer before swapping shortcuts for esc to cancel.
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

    // A name-only shell title cannot prove a wording-free picker ready.
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

    // Only the screen proves readiness here, so settlement proves grid trust.
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
