import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { makeTuiIdlePty } from './tui-idle-wait-test-harness'
import { ptyTuiIdleEvidence, type TuiIdleEvidenceSource } from './tui-idle-evidence-source'
import { TUI_IDLE_QUIESCENCE_MS } from './terminal-idle-policy'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// Codex 0.171's startup "Hooks need review" picker (startup_hooks_review.rs), drawn in its inline viewport.
const CODEX_HOOKS_REVIEW =
  '\x1b[2;3HHooks need review\x1b[3;3H1 hook is new or changed.' +
  '\x1b[4;3HHooks can run outside the sandbox after you trust them.' +
  '\x1b[6;1H› 1. Review hooks\x1b[7;3H2. Trust all and continue' +
  "\x1b[8;3H3. Continue without trusting (hooks won't run)" +
  '\x1b[10;3Henter confirm · esc skip'
const CODEX_COMPOSER_REPAINT =
  '\x1b[1;1H\x1b[J\x1b[20;1H› Ask Codex to do anything\x1b[22;3H? for shortcuts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function evidenceSource(
  readScreenClearingBlockedTail: TuiIdleEvidenceSource['readScreenClearingBlockedTail']
): TuiIdleEvidenceSource {
  return {
    quiescenceMs: TUI_IDLE_QUIESCENCE_MS,
    getAdoptedPtyIdleStatus: () => null,
    getPaneAgent: () => 'codex',
    getFirstPartyAgentStatus: () => null,
    readScreenLines: () => null,
    readScreenClearingBlockedTail
  }
}

describe('tui-idle wait over a dismissed Codex hooks review', () => {
  it.each([
    ['satisfies once Codex repaints its composer over', true],
    ['stays blocked while the screen still shows', false]
  ])('%s the startup hooks review', async (_name, dismissed) => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: 'codex',
      data: '',
      launchAgent: 'codex',
      size: { cols: 80, rows: 24 }
    })
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, CODEX_HOOKS_REVIEW, Date.now())
    if (dismissed) {
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, CODEX_COMPOSER_REPAINT, Date.now())
    }
    // Why real timers until the read: the emulator drains on timers, and the screen may clear only once quiet.
    const outputAt = Date.now()
    await runtime.readTerminal(handle, { screen: true })
    vi.useFakeTimers({ now: Math.max(outputAt, Date.now()) + TUI_IDLE_QUIESCENCE_MS })

    const wait = await runtime.waitForTerminal(handle, {
      condition: 'tui-idle',
      timeoutMs: 1_000,
      launchReadiness: true
    })

    expect([wait.satisfied, wait.blockedReason ?? null]).toEqual(
      dismissed ? [true, null] : [false, 'agent-hooks-review-prompt']
    )
  })

  it('never reads the screen when the tail shows no blocker', () => {
    const readScreenClearingBlockedTail = vi.fn(() => null)
    const evidence = ptyTuiIdleEvidence(
      evidenceSource(readScreenClearingBlockedTail),
      makeTuiIdlePty(),
      () => '› Ask Codex to do anything'
    )

    expect(evidence.readTailBlockedReason()).toBeNull()
    expect(readScreenClearingBlockedTail).not.toHaveBeenCalled()
  })
})
