import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { readRuntimeFixture, readTimedRuntimeFixture } from './agent-transcript-replay-test-harness'
import { waitForWorkerStartComposer } from './launched-agent-composer-readiness'
import { RuntimeMachineName } from './runtime-machine-name'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const NO_TITLE_BOOT = 'claude-2-1-310-timed-boot-no-title'

describe('a Claude worker start with its terminal title turned off', () => {
  beforeEach(() => {
    vi.spyOn(RuntimeMachineName.prototype, 'start').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each(['idle', 'marker'] as const)(
    'still accepts the other source after a local %s failure',
    async (failed) => {
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: 'claude',
        launchAgent: 'claude',
        data: ''
      })
      vi.spyOn(
        runtime,
        failed === 'idle' ? 'waitForTerminal' : 'waitForFreshWorkerComposer'
      ).mockRejectedValue(new Error('source_unavailable'))
      vi.useFakeTimers()
      const outcome = waitForWorkerStartComposer(runtime, handle, 'claude', 60_000)
      const settled = vi.fn()
      outcome.then(settled, settled)
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        readRuntimeFixture(
          failed === 'idle' ? NO_TITLE_BOOT : 'claude-dialog-trust-workspace-answered'
        ),
        Date.now()
      )
      await vi.advanceTimersByTimeAsync(1_000)
      expect(settled).toHaveBeenCalledOnce()
      await expect(outcome).resolves.toMatchObject({ satisfied: true })
      expect(runtime['terminalWaiters'].forPty(TRANSCRIPT_PANE_PTY_ID)).toHaveLength(0)
    }
  )

  it('is ready on its composer, which is the only signal it draws', async () => {
    const { chunks, times } = readTimedRuntimeFixture(NO_TITLE_BOOT)
    // Presence precondition: no OSC title, so tui-idle alone never settles (#22655).
    expect(chunks.join('')).not.toContain('\x1b]0;')
    const composerAt = times[chunks.findIndex((chunk) => chunk.includes('❯ '))]
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: 'claude',
      launchAgent: 'claude',
      size: { cols: 120, rows: 40 },
      data: ''
    })
    vi.useFakeTimers()
    const startedAt = Date.now()
    let settledAt: number | null = null
    void waitForWorkerStartComposer(runtime, handle, 'claude', 20_000).then(
      (wait) => {
        settledAt = wait.satisfied ? Date.now() - startedAt : null
      },
      () => {}
    )
    for (const [index, chunk] of chunks.entries()) {
      await vi.advanceTimersByTimeAsync(Math.max(0, startedAt + times[index] - Date.now()))
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, Date.now())
    }
    await vi.advanceTimersByTimeAsync(5_000)
    expect(settledAt).not.toBeNull()
    expect(settledAt).toBeGreaterThanOrEqual(composerAt)
    expect(settledAt).toBeLessThan(composerAt + 1_000)
    expect(runtime['terminalWaiters'].forPty(TRANSCRIPT_PANE_PTY_ID)).toHaveLength(0)
    expect(
      runtime['terminalStreamConsumers']['dataListeners'].get(TRANSCRIPT_PANE_PTY_ID)
    ).toBeUndefined()
  })
})

describe('the Claude composer marker', () => {
  const firesOn = (fixture: string): boolean => {
    const scanner = createDraftPasteReadyScanner('claude-composer-prompt')
    return scanner.observe(readRuntimeFixture(fixture)).ready
  }

  it('does not fire on the workspace-trust menu, which draws the same pointer', () => {
    expect(readRuntimeFixture('claude-dialog-trust-workspace')).toContain('❯')
    expect(firesOn('claude-dialog-trust-workspace')).toBe(false)
  })

  it('fires once that menu is answered and the composer mounts', () => {
    expect(firesOn('claude-dialog-trust-workspace-answered')).toBe(true)
  })

  // A powerlevel10k/starship prompt draws the same `❯` + NBSP after the shell's own DECSET 2004.
  const SHELL_PROMPT = '\x1b[?2004h~/repo \x1b[32m❯ \x1b[0m'

  it('does not fire on a shell prompt that draws the same glyph', () => {
    // Presence precondition: the shell turns bracketed paste on just as Claude does.
    expect(readRuntimeFixture('zsh-prompt-runs-command')).toContain('\x1b[?2004h')
    const scanner = createDraftPasteReadyScanner('claude-composer-prompt')
    expect(scanner.observe(readRuntimeFixture('zsh-prompt-runs-command')).ready).toBe(false)
    expect(scanner.observe(SHELL_PROMPT).ready).toBe(false)
  })

  it('does not fire on a fish prompt cycle, which holds palette reports while idle', () => {
    const scanner = createDraftPasteReadyScanner('claude-composer-prompt')
    // fish 4+: 2031/2004 on at its prompt, off when it runs the launch line.
    expect(scanner.observe('\x1b[?2031h\x1b[?2004h~/repo> claude\r\n').ready).toBe(false)
    expect(scanner.observe('\x1b[?2004l\x1b[?2031l').ready).toBe(false)
    expect(scanner.observe(SHELL_PROMPT).ready).toBe(false)
  })

  it('does not fire on the shell prompt drawn after Claude exits', () => {
    const scanner = createDraftPasteReadyScanner('claude-composer-prompt')
    const boot = readRuntimeFixture('claude-dialog-trust-workspace')
    expect(scanner.observe(boot).ready).toBe(false)
    // Claude drops its modes on exit, as the answered-trust capture shows mid-boot.
    expect(scanner.observe('\x1b[?1004l\x1b[?2031l\x1b[?2004l\r\n').ready).toBe(false)
    expect(scanner.observe(SHELL_PROMPT).ready).toBe(false)
  })
})
