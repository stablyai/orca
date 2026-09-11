/**
 * Pins Antigravity readiness to captured transcripts instead of hand-written fixtures.
 *
 * Five detector attempts were tuned against a five-line screen someone typed from memory, and
 * three of them shipped worse behaviour than the bug they replaced. Nothing here asserts what
 * Antigravity prints: the transcripts do. Until they exist these cases skip, loudly and by name.
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

type TranscriptCase = {
  /** Fixture basename; `<name>.txt` under `__fixtures__/`. */
  name: string
  /** Capture in docs/reference/antigravity-readiness-evidence.md. */
  capture: string
  what: string
  expectReady: boolean
}

const TRANSCRIPTS: readonly TranscriptCase[] = [
  {
    name: 'antigravity-ready-business-non-gemini',
    capture: 'A',
    what: 'ready screen, Business account, non-Gemini model',
    expectReady: true
  },
  {
    name: 'antigravity-ready-personal-non-gemini',
    capture: 'B',
    what: 'ready screen, personal/API-key account, non-Gemini model — the reported wedge',
    expectReady: true
  },
  {
    name: 'antigravity-dialog-sign-in',
    capture: 'C',
    what: 'sign-in dialog owning the screen',
    expectReady: false
  },
  {
    name: 'antigravity-dialog-model-picker',
    capture: 'C',
    what: 'model picker owning the screen',
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
  },
  {
    name: 'antigravity-dialog-dismissed',
    capture: 'D',
    what: 'the screen immediately after a dialog is dismissed',
    expectReady: true
  }
]

function fixturePath(name: string): string {
  return join(FIXTURE_DIR, `${name}.txt`)
}

async function readinessVerdict(
  transcript: string
): Promise<{ satisfied: boolean; blockedReason: unknown }> {
  const { runtime, handle } = await createTranscriptPane({
    // Why the transcript's own title: every attempt guessed at Antigravity's title. A raw
    // capture carries the OSC bytes, so the pane wears whatever the CLI actually set.
    paneTitle: extractLastOscTitle(transcript) ?? ANTIGRAVITY_COMMAND,
    foregroundProcess: ANTIGRAVITY_COMMAND,
    data: transcript
  })
  const result = (await runtime.waitForTerminal(handle, {
    condition: 'tui-idle',
    timeoutMs: READY_TIMEOUT_MS
  })) as { satisfied?: boolean; blockedReason?: unknown }
  return { satisfied: result.satisfied === true, blockedReason: result.blockedReason ?? null }
}

async function refusalVerdict(transcript: string): Promise<boolean> {
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: extractLastOscTitle(transcript) ?? ANTIGRAVITY_COMMAND,
    foregroundProcess: ANTIGRAVITY_COMMAND,
    data: transcript
  })
  const result = (await runtime.waitForTerminal(handle, {
    condition: 'tui-idle',
    timeoutMs: REFUSAL_TIMEOUT_MS
  })) as { satisfied?: boolean }
  return result.satisfied === true
}

describe('Antigravity readiness, decided by captured transcripts', () => {
  for (const transcript of TRANSCRIPTS) {
    const path = fixturePath(transcript.name)
    const captured = existsSync(path)
    const label = `capture ${transcript.capture}: ${transcript.what}`

    it.skipIf(!captured)(
      `${label} → ${transcript.expectReady ? 'ready' : 'not ready'}`,
      async () => {
        const text = readFileSync(path, 'utf8')
        if (transcript.expectReady) {
          const verdict = await readinessVerdict(text)
          expect(verdict).toMatchObject({ satisfied: true })
        } else {
          // A silent dialog carries no blocked-signal wording, so the only safe assertion is
          // that Orca does not call the pane ready and type a prompt into the dialog.
          await expect(refusalVerdict(text)).resolves.toBe(false)
        }
      },
      READY_TIMEOUT_MS + 10_000
    )

    it.skipIf(!captured)(`${label} was captured raw, not pasted from a rendered screen`, () => {
      const text = readFileSync(path, 'utf8')
      // Why: a transcript with no escape bytes went through a terminal's renderer and a
      // human's clipboard. It cannot answer what the caret or chrome looked like.
      expect(text).toContain('')
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
      ].join('\n')
    )
    expect(verdict.satisfied).toBe(true)
  })

  it('reaches a not-ready verdict through the harness', async () => {
    await expect(
      refusalVerdict('Do you trust this workspace directory?\nPress t to trust\n')
    ).resolves.toBe(false)
  })
})
