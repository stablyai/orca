// Replays captured agy screens through the real runtime wait at their recorded 120×40 grid.
// Capture protocol: docs/reference/agent-pty-transcript-capture.md.
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
// Allow the 2s idle poll to observe the asynchronously rendered snapshot before timing out.
const READY_TIMEOUT_MS = 3_500
const REFUSAL_TIMEOUT_MS = READY_TIMEOUT_MS
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
  beforeShutdown?: boolean
}

const TRANSCRIPTS: readonly TranscriptCase[] = [
  {
    name: 'antigravity-ready-api-key-gemini-model',
    beforeShutdown: true,
    capture: 'B',
    what: 'ready screen, API-key identity — the account row reads "Gemini API key", not an email',
    expectReady: true
  },
  {
    name: 'antigravity-ready-account-info-hidden',
    beforeShutdown: true,
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
    expectReady: true
  },
  {
    name: 'antigravity-dialog-dismissed',
    beforeShutdown: true,
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

function liveCapture(transcript: TranscriptCase): string {
  const raw = readFileSync(fixturePath(transcript.name), 'utf8')
  if (!transcript.beforeShutdown) {
    return raw
  }
  // These recordings include process shutdown, which erases the live shortcut footer.
  const shutdown = `${ESC}[>4m${ESC}[=0;1u`
  const offset = raw.lastIndexOf(shutdown)
  expect(offset).toBeGreaterThan(0)
  expect(raw.slice(offset)).toContain(`${ESC}[?2004l`)
  return raw.slice(0, offset)
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
    size: { cols: 120, rows: 40 },
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

    const verdictName = `${label} → ${transcript.expectReady ? 'ready' : 'not ready'}`

    it.skipIf(!captured)(
      verdictName,
      async () => {
        const verdict = await readinessVerdict(
          liveCapture(transcript),
          transcript.expectReady ? READY_TIMEOUT_MS : REFUSAL_TIMEOUT_MS
        )
        // A silent dialog carries no blocked-signal wording, so the assertion is only that Orca
        // does not call the pane ready and type a prompt into a dialog that owns the screen.
        expect({ ready: verdict.ready, outcome: verdict.outcome }).toMatchObject({
          ready: transcript.expectReady
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
  // Verify both completion paths independently of the capture inventory.
  it('reaches a ready verdict through the harness', async () => {
    const verdict = await readinessVerdict(
      readFileSync(fixturePath('antigravity-ready-default-127'), 'utf8'),
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
