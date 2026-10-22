import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { store, syncSinglePty } from '../orca-runtime-test-fixtures.spec'
import { assertExplicitWorkerTerminalUsable } from '../rpc/methods/orchestration/worker/explicit-worker-terminal-validation'

async function fixture(foreground: string | null, inspection: string | null) {
  const inspectProcess = vi.fn(async () => ({
    foregroundProcess: inspection,
    hasChildProcesses: inspection !== null && inspection !== 'zsh'
  }))
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => foreground,
    inspectProcess
  })
  syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash', tabTitle: 'bash' })
  const [listed] = (await runtime.listTerminals()).terminals
  const terminal = {
    ...(await runtime.showTerminal(listed.handle)),
    incarnationId: 'worker-incarnation'
  }
  const showTerminal = runtime.showTerminal.bind(runtime)
  vi.spyOn(runtime, 'showTerminal').mockImplementation(async (handle) =>
    handle === 'term_coord'
      ? { ...terminal, handle: 'term_coord' }
      : handle === terminal.handle
        ? terminal
        : showTerminal(handle)
  )
  const getPaneKey = runtime.getTerminalPaneKey.bind(runtime)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === 'term_coord' ? 'coord:pane' : getPaneKey(handle)
  )
  return {
    runtime,
    terminal,
    inspectProcess,
    validate: () =>
      assertExplicitWorkerTerminalUsable({
        runtime,
        terminal: terminal.handle,
        from: 'term_coord',
        coordinator: null,
        resolvedWorktreeId: terminal.worktreeId
      })
  }
}

describe('explicit worker terminal foreground confirmation', () => {
  it.each(['zsh', null])(
    'admits a live DSH after a stale cached foreground (%s)',
    async (cached) => {
      const { runtime, terminal, inspectProcess, validate } = await fixture(cached, 'dsh-tui')
      await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)

      await expect(validate()).resolves.toBeUndefined()
      expect(inspectProcess).toHaveBeenCalledExactlyOnceWith('pty-1', {
        scanChildProcesses: true,
        expectedIncarnationId: 'worker-incarnation'
      })
      // The cached provider stays stale: admission must use the returned inspection directly.
      await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
    }
  )

  it.each(['zsh', null])(
    'refuses a non-agent or unverifiable fresh foreground (%s)',
    async (fresh) => {
      const { validate, inspectProcess } = await fixture('zsh', fresh)
      await expect(validate()).rejects.toMatchObject({ code: 'agent_unconfigured' })
      expect(inspectProcess).toHaveBeenCalledOnce()
    }
  )

  it('does not add a process scan when the existing foreground is already recognized', async () => {
    const { validate, inspectProcess } = await fixture('dsh-tui', 'zsh')
    await expect(validate()).resolves.toBeUndefined()
    expect(inspectProcess).not.toHaveBeenCalled()
  })

  it('preserves a process-inspection failure instead of authorizing input', async () => {
    const { validate, inspectProcess } = await fixture('zsh', 'dsh-tui')
    inspectProcess.mockRejectedValue(new Error('terminal_handle_stale'))
    await expect(validate()).rejects.toThrow('terminal_handle_stale')
  })
})
