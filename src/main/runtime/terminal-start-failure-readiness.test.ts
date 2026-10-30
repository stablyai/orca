import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { waitForWorkerAgentReady } from './launched-agent-composer-readiness'
import { formatTerminalStartFailure } from '../../shared/terminal-start-failure'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('accepted spawn followed by failed startup readiness', () => {
  it.each(['codex', 'opencode'] as const)(
    'carries the real %s readiness lane exit into the start failure',
    async (agent) => {
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'shell',
        foregroundProcess: 'bash',
        launchAgent: agent,
        data: ''
      })
      vi.useFakeTimers()
      const result = waitForWorkerAgentReady(runtime, handle, {
        agent,
        reusesTerminal: false,
        timeoutMs: 50
      }).catch((error: unknown) => error)
      runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 256, 'inc-1', {
        providerExitObserved: true,
        cause: {
          kind: 'exited',
          exitCode: 256,
          initialOutputDiagnostic: 'git-bash-console-capacity'
        }
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(await result).toMatchObject({
        message: expect.any(String),
        terminalExitCause: expect.objectContaining({ kind: 'exited' })
      })
      expect(formatTerminalStartFailure(await result)).toContain('128 open terminals on this PC')
    }
  )

  it('keeps reused-terminal readiness and ordinary later waits generic', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'shell',
      foregroundProcess: 'bash',
      data: ''
    })
    const reused = waitForWorkerAgentReady(runtime, handle, {
      agent: 'codex',
      reusesTerminal: true,
      timeoutMs: 50
    }).catch((error: unknown) => error)
    const ordinary = runtime
      .waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 50 })
      .catch((error: unknown) => error)
    runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 256, 'inc-1', {
      providerExitObserved: true,
      cause: { kind: 'exited', exitCode: 256, initialOutputDiagnostic: 'git-bash-console-capacity' }
    })
    expect(formatTerminalStartFailure(await reused)).toBeUndefined()
    expect(formatTerminalStartFailure(await ordinary)).toBeUndefined()
  })
})
