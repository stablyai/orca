import { expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { registerTerminalPtyExitWaiterTests } from './terminal-pty-exit-waiter.spec'
import { registerClaudeAgentTeamsPtyExitLeakTests } from './claude-agent-teams-pty-exit-leak.spec'
import { registerPtyExitAgentStatusReconciliationTests } from './pty-exit-agent-status-reconciliation.spec'
import { registerPtyTranscriptPruneWaitCacheTests } from './pty-transcript-prune-wait-cache.spec'

registerTerminalPtyExitWaiterTests()
registerClaudeAgentTeamsPtyExitLeakTests()
registerPtyExitAgentStatusReconciliationTests()
registerPtyTranscriptPruneWaitCacheTests()

it('reports an already-exited terminal from the idle wait command', async () => {
  const originalExitCode = process.exitCode
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'shell',
    foregroundProcess: 'bash',
    data: ''
  })
  runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 137, 'inc-1', { providerExitObserved: true })
  const callMock = vi.fn(
    async (method: string, params: { terminal: string; for: 'tui-idle'; timeoutMs: number }) => {
      expect(method).toBe('terminal.wait')
      return runtime.waitForTerminal(params.terminal, {
        condition: params.for,
        timeoutMs: params.timeoutMs
      })
    }
  )
  vi.doMock('../../cli/runtime-client', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    RuntimeClient: class {
      call = callMock
    }
  }))
  try {
    process.exitCode = undefined
    vi.stubEnv('ORCA_ENVIRONMENT', '')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cliPath = '../../cli/index'
    const { main }: { main(argv: string[], cwd: string): Promise<void> } = await import(cliPath)

    await main(
      ['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', '25'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledExactlyOnceWith(
      'terminal.wait',
      { terminal: handle, for: 'tui-idle', timeoutMs: 25 },
      { timeoutMs: 5025 }
    )
    expect(process.exitCode).toBe(1)
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('terminal_exited')
    expect(runtime['terminalWaiters'].forPty(TRANSCRIPT_PANE_PTY_ID)).toHaveLength(0)
  } finally {
    process.exitCode = originalExitCode
    vi.doUnmock('../../cli/runtime-client')
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.resetModules()
  }
})
