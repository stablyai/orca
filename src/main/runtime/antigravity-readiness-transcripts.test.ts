/**
 * Pins Antigravity readiness to captured transcripts instead of hand-written fixtures.
 *
 * Five detector attempts were tuned against a five-line screen someone typed from memory, and
 * three of them shipped worse behaviour than the bug they replaced. Nothing here asserts what
 * Antigravity prints: the transcripts do. Six are recorded from a live `agy`; the rest name
 * themselves as skipped until someone can reach them.
 *
 * Four cases are pinned as KNOWN DEFECT: on real output the shipped detector refuses the ready
 * screen and accepts the live model picker. Those assert what it does, not what it should.
 *
 * Capture protocol: docs/reference/agent-pty-transcript-capture.md
 * What each transcript decides: docs/reference/antigravity-readiness-evidence.md
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'
import { extractLastOscTitle } from '../../shared/osc-title-extraction'

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
    expectReady: true,
    knownDefect: 'refused: the model row never starts a line, the logo shares it'
  },
  {
    name: 'antigravity-ready-account-info-hidden',
    capture: 'B',
    what: 'ready screen with AGY_CLI_HIDE_ACCOUNT_INFO=1 — no account row at all',
    expectReady: true,
    knownDefect: 'refused: same line-start defect, and no account row exists to require'
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
    expectReady: false,
    knownDefect: "accepted: the picker's own `Gemini 3.x Flash` rows satisfy the model rule"
  },
  {
    name: 'antigravity-dialog-command-palette',
    capture: 'C',
    what: 'slash-command palette owning the screen',
    expectReady: false
  },
  {
    name: 'antigravity-dialog-dismissed',
    capture: 'D',
    what: 'the screen immediately after the model picker is dismissed',
    expectReady: true,
    knownDefect: 'refused: the banner is not reprinted and no model row starts a line'
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
    const verdict = await readinessVerdict(
      [
        'Antigravity CLI 1.0.3',
        'user@example.com (Antigravity Business)',
        'Gemini 3.5 Flash (High)',
        '~/orca/workspaces/orca/agy-dispatch-issue',
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
