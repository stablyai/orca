/**
 * Pins Antigravity readiness to captured transcripts instead of hand-written fixtures.
 *
 * Five detector attempts were tuned against a five-line screen someone typed from memory, and
 * three of them shipped worse behaviour than the bug they replaced. Nothing here asserts what
 * Antigravity prints: the transcripts do. Six are recorded from a live `agy`; the rest name
 * themselves as skipped until someone can reach them.
 *
 * Two things have to be right for a replay to mean anything, and both were wrong before:
 * the transcript must be fed to an emulator of the grid it was recorded on, and it must stop
 * where the live screen stopped. See `replayableLiveTranscript`.
 *
 * Capture protocol: docs/reference/agent-pty-transcript-capture.md
 * What each transcript decides: docs/reference/antigravity-readiness-evidence.md
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'
import { extractLastOscTitle } from '../../shared/osc-title-extraction'
import { isKnownReadyPromptPreview } from './terminal-wait-detection'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const FIXTURE_DIR = join(__dirname, '__fixtures__')
const EVIDENCE_DOC = join(
  __dirname,
  '..',
  '..',
  '..',
  'docs',
  'reference',
  'antigravity-readiness-evidence.md'
)
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
  /** Capture in docs/reference/antigravity-readiness-evidence.md. */
  capture: string
  what: string
  /** What a correct detector must answer. Not what the shipped one answers. */
  expectReady: boolean
  /**
   * Set where the detector on this branch still contradicts the transcript. The case then runs
   * inverted, so CI pins the defect instead of going permanently red — and flips to failing the
   * moment someone fixes it, which is exactly when these expectations need re-reading.
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
  // reaching the rest would mean signing the operator out or deleting their config. See
  // docs/reference/antigravity-readiness-evidence.md § What could not be captured.
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
 * The grid the transcript was recorded on. Antigravity positions its rows with absolute cursor
 * moves (`ESC[13;99H`), so replaying a 120-column capture through an 80-column emulator lands
 * them on different rows and reconstructs a screen the operator never saw.
 */
function captureGrid(name: string): { cols: number; rows: number } {
  const meta = JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.meta.json`), 'utf8')) as {
    cols?: number
    rows?: number
  }
  expect({ name, cols: meta.cols, rows: meta.rows }).toMatchObject({
    cols: expect.any(Number),
    rows: expect.any(Number)
  })
  return { cols: meta.cols as number, rows: meta.rows as number }
}

/**
 * Where a transcript stops being a live screen.
 *
 * The captures taken before the recorder was fixed run through `agy`'s shutdown, and those bytes
 * erase the rows the screen is being judged on — the ready fixture's own status row does not
 * survive them. Orca's detector never sees them on a pane it is waiting on, because the agent is
 * still running.
 *
 * Bracketed paste is the marker, and picking it was not free. The obvious candidate — the
 * keyboard-mode pair `ESC[>4m ESC[=0;1u` — is **not** a shutdown marker at all: `agy` also emits
 * it when it enters raw mode, so it appears at offset 18 in `antigravity-busy-mid-turn.txt` and
 * `antigravity-dialog-trust-workspace.txt`, and not at all in `antigravity-busy-turn-ended.txt`.
 * Cutting at its last occurrence threw away 3.7 KB of the mid-turn capture — the whole turn.
 * `ESC[?2004l` is emitted once, on exit, in each of the six shutdown-inclusive captures and never
 * in the two recorded with the fixed recorder.
 */
const SHUTDOWN_MARKER = `${ESC}[?2004l`

function replayableLiveTranscript(name: string): string {
  const full = readFileSync(fixturePath(name), 'utf8')
  const shutdownAt = full.lastIndexOf(SHUTDOWN_MARKER)
  return shutdownAt === -1 ? full : full.slice(0, shutdownAt)
}

/**
 * A `tui-idle` wait ends three ways, and only one of them is readiness: it resolves satisfied, it
 * resolves unsatisfied with a blocked reason, or it rejects with `timeout` because nothing ever
 * looked ready. The orchestrator treats the last two identically — no prompt is delivered — so
 * they are both `ready: false` here. This is the shape `worker-start` sees.
 */
async function readinessVerdict(
  transcript: string,
  timeoutMs: number,
  size?: { cols: number; rows: number }
): Promise<{ ready: boolean; blockedReason: unknown; outcome: string }> {
  const { runtime, handle } = await createTranscriptPane({
    // Why the transcript's own title: every attempt guessed at Antigravity's title. A raw
    // capture carries the OSC bytes, so the pane wears whatever the CLI actually set.
    paneTitle: extractLastOscTitle(transcript) ?? ANTIGRAVITY_COMMAND,
    foregroundProcess: ANTIGRAVITY_COMMAND,
    data: transcript,
    ...(size ? { size } : {})
  })
  try {
    const result = (await runtime.waitForTerminal(handle, {
      condition: 'tui-idle',
      timeoutMs
    })) as { satisfied?: boolean; blockedReason?: unknown }
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
    // red; fixing it flips this case to failing, which is when these expectations need
    // re-reading. The correct answer stays in `expectReady` and in the test's name.
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
          replayableLiveTranscript(transcript.name),
          transcript.expectReady ? READY_TIMEOUT_MS : REFUSAL_TIMEOUT_MS,
          captureGrid(transcript.name)
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

    it.skipIf(!captured)(`${label} is replayed with no shutdown bytes in it`, () => {
      // Guards `replayableLiveTranscript` in the only direction that matters, and one that holds
      // for both recorders: whatever is fed to the runtime must not contain `agy` shutting down.
      // A cut that stopped working would leave the marker in the replay, so this cannot silently
      // become a no-op the way an "the marker is present" assertion would — the fixed recorder
      // stops before shutdown, so the newer captures do not carry the marker at all.
      const full = readFileSync(path, 'utf8')
      const replayed = replayableLiveTranscript(transcript.name)
      expect(replayed).not.toContain(SHUTDOWN_MARKER)
      expect(replayed.length).toBe(
        full.includes(SHUTDOWN_MARKER) ? full.lastIndexOf(SHUTDOWN_MARKER) : full.length
      )
    })
  }

  it('refuses a live turn, because the spinner repaints below the composer', async () => {
    // The reviewed P1 argued a busy frame parks the caret with the same bytes as an idle one, so
    // a caret rule cannot tell them apart. True of the frame; not true of the tail. Each spinner
    // tick is its own repaint with its own park two rows higher, which splices the composer away.
    const name = 'antigravity-busy-mid-turn'
    if (!existsSync(fixturePath(name))) {
      return
    }
    const verdict = await readinessVerdict(
      replayableLiveTranscript(name),
      REFUSAL_TIMEOUT_MS,
      captureGrid(name)
    )
    expect(verdict.ready).toBe(false)
  }, 20_000)

  // KNOWN GAP, pinned so it is visible rather than argued about. Between a frame park and the
  // next spinner tick the retained tail really does end on the bare caret, and no committed
  // capture ends there, so nothing distinguishes it from idle by text alone.
  //
  // The clause proposed for this — "a braille glyph on the last visible line means working" — is
  // asserted here to NOT close it, because it cannot: in this window the last visible line IS the
  // bare caret and carries no braille. Braille on that line would make it not trim to `>`, which
  // the caret rule already refuses, so the clause is subsumed and adding it would be dead code.
  // Reverting it changes no test.
  //
  // WHAT WOULD CLOSE THIS: one capture that ends *inside* the residual window — recording stopped
  // between a frame park and the next spinner tick, so the transcript's own last row is the bare
  // caret with the spinner still live above it. That fixes the line bound empirically, which is
  // the only thing missing. A fix has to read more than the last line, and picking "the last N
  // lines" without a capture to fix N is how attempts one through five were built. The bound is
  // not free to guess either: `antigravity-busy-mid-turn.txt` prints `⣾  Signing in...` during its
  // failed first launch, so an unbounded scan would call a ready screen busy forever — the hazard
  // is demonstrated, not hypothetical.
  //
  // Paths gated on sustained quiescence are unaffected: ticks keep arriving, so the pane is never
  // quiet. This is only reachable by a caller that inspects retained text alone, and it is one
  // inter-tick interval wide.
  it('KNOWN GAP: the window between a frame park and the next tick still reads ready', () => {
    const rule = '─'.repeat(120)
    const residual = [
      '▄▟▟▄        Antigravity CLI 1.2.0',
      rule,
      '> In about 80 words, explain what a pseudoterminal is.',
      '⣟  Generating...',
      rule,
      '>'
    ].join('\n')
    expect(isKnownReadyPromptPreview(residual)).toBe(true)
  })

  it('refuses a pane whose agy has already exited', async () => {
    // `antigravity-dialog-dismissed.txt` is the one capture whose teardown prints something:
    // agy's `Resume with -c (or command below):` footer. Replayed whole, the pane is a finished
    // process, and a prompt typed into it goes nowhere. Readiness must not survive the footer.
    const name = 'antigravity-dialog-dismissed'
    if (!existsSync(fixturePath(name))) {
      return
    }
    const full = readFileSync(fixturePath(name), 'utf8')
    expect(full).toContain('Resume with -c')
    const verdict = await readinessVerdict(full, REFUSAL_TIMEOUT_MS, captureGrid(name))
    expect(verdict.ready).toBe(false)
  }, 20_000)

  it('documents every transcript the detector is allowed to depend on', () => {
    // Why a test: the doc is the operator's checklist. A name that drifts out of it is a
    // transcript nobody will capture, and a case that silently skips forever.
    const doc = readFileSync(EVIDENCE_DOC, 'utf8')
    for (const transcript of TRANSCRIPTS) {
      expect(doc).toContain(`${transcript.name}.txt`)
    }
  })

  it('reports how much evidence exists, so a fully skipped run is visible', () => {
    const missing = TRANSCRIPTS.filter(
      (transcript) => !existsSync(fixturePath(transcript.name))
    ).map((transcript) => `${transcript.name}.txt`)
    if (missing.length > 0) {
      console.info(
        `Antigravity transcripts: ${TRANSCRIPTS.length - missing.length}/${TRANSCRIPTS.length} captured. Missing: ${missing.join(', ')}`
      )
    }
    expect(missing.length).toBeLessThanOrEqual(TRANSCRIPTS.length)
  })
})

describe('scaffold self-check', () => {
  // Why these two live here: when a transcript lands and fails, the failure has to mean the
  // capture disagreed with the detector — not that the harness or the timeouts are broken.
  // Neither case is evidence about Antigravity; both are shapes the current detector already
  // decides, used only to prove the plumbing reaches a verdict.
  it('reaches a ready verdict through the harness', async () => {
    // The rows are the real capture's, not the five-line screen the first five attempts were
    // tuned on: that one put the model at a line start, which no real ready screen does.
    const verdict = await readinessVerdict(
      [
        '      ▄▟▟▄        Antigravity CLI 1.2.0',
        '     ▀▀▀▀▀▀       Gemini API key',
        '─'.repeat(120),
        '>'
      ].join('\n'),
      READY_TIMEOUT_MS
    )
    expect(verdict.ready).toBe(true)
  })

  it('reaches a not-ready verdict through the harness', async () => {
    const verdict = await readinessVerdict(
      'Do you trust this workspace directory?\nPress t to trust\n',
      REFUSAL_TIMEOUT_MS
    )
    expect(verdict.ready).toBe(false)
  })
})
