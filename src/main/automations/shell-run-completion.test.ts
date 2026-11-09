import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import { observeShellRunCompletion, type ShellRunTerminalHost } from './shell-run-completion'

const run: AutomationRun = {
  id: 'shell-run',
  automationId: 'shell-automation',
  title: 'Shell command',
  scheduledFor: 1,
  status: 'dispatched',
  trigger: 'manual',
  workspaceId: 'folder-workspace',
  sessionKind: 'terminal',
  completionCondition: 'exit',
  terminalIncarnationId: 'incarnation-1',
  terminalPtyId: 'pty-1',
  terminalPaneKey: 'tab-1:leaf-1',
  terminalSessionId: 'tab-1',
  chatSessionId: null,
  outputSnapshot: null,
  precheckResult: null,
  usage: null,
  error: null,
  startedAt: 1,
  dispatchedAt: 1,
  createdAt: 1
}

type WaitResult = Awaited<ReturnType<ShellRunTerminalHost['waitForTerminal']>>

function exited(exitCode: number): WaitResult {
  return { satisfied: true, exitCode, exitCause: { kind: 'exited', exitCode } }
}

function receipt(exitCode: number, runId = run.id): string {
  return `\u001b]133;D;${exitCode};orca-automation:${runId}\u0007`
}

function createHost(initialTail: string[] = []) {
  const listeners = new Set<(data: string) => void>()
  const unsubscribe = vi.fn(() => listeners.clear())
  const readTerminal = vi
    .fn<ShellRunTerminalHost['readTerminal']>()
    .mockResolvedValue({ tail: initialTail })
  const waitForTerminal = vi
    .fn<ShellRunTerminalHost['waitForTerminal']>()
    .mockResolvedValue(exited(0))
  const subscribeToTerminalData = vi.fn((_ptyId: string, listener: (data: string) => void) => {
    listeners.add(listener)
    return unsubscribe
  })
  const runtime: ShellRunTerminalHost = {
    getTerminalHandleForPaneKey: () => 'terminal-1',
    resolveTerminalPane: () => ({
      handle: 'terminal-1',
      ptyId: 'pty-1',
      incarnationId: 'incarnation-1'
    }),
    readTerminal,
    waitForTerminal,
    subscribeToTerminalData
  }
  return {
    runtime,
    readTerminal,
    waitForTerminal,
    subscribeToTerminalData,
    unsubscribe,
    emit: (chunk: string) => listeners.forEach((listener) => listener(chunk))
  }
}

function createConnectedHost() {
  const host = createHost()
  const exitListeners = new Set<() => void>()
  const unsubscribeExit = vi.fn(() => exitListeners.clear())
  const terminal = {
    handle: 'terminal-1',
    ptyId: 'pty-1',
    incarnationId: 'incarnation-1',
    connected: true
  }
  host.runtime.resolveTerminalPane = () => terminal
  const subscribeToPtyExit = vi.fn((_ptyId: string, listener: () => void) => {
    exitListeners.add(listener)
    return unsubscribeExit
  })
  host.runtime.subscribeToPtyExit = subscribeToPtyExit
  return {
    ...host,
    terminal,
    subscribeToPtyExit,
    unsubscribeExit,
    exit: () => {
      terminal.connected = false
      exitListeners.forEach((listener) => listener())
    }
  }
}

afterEach(() => vi.useRealTimers())

function observe(host: ReturnType<typeof createHost>, retainedRun = run) {
  return observeShellRunCompletion(
    host.runtime,
    'terminal-1',
    retainedRun,
    new AbortController().signal
  )
}

describe('host-owned shell run completion', () => {
  it('retains streamed output when the terminal tail is removed at exit', async () => {
    const host = createHost(['command started'])
    host.waitForTerminal.mockImplementation(async () => {
      host.emit('\u001b[32mcommand finished\u001b[0m\r\n')
      host.emit(receipt(0))
      host.readTerminal.mockRejectedValue(new Error('terminal_not_found'))
      return exited(0)
    })
    expect(await observe(host)).toMatchObject({
      status: 'completed',
      error: null,
      outputSnapshot: {
        format: 'plain_text',
        content: 'command started\ncommand finished',
        truncated: false
      }
    })
    expect(host.readTerminal).toHaveBeenCalledOnce()
    expect(host.subscribeToTerminalData).toHaveBeenCalledWith('pty-1', expect.any(Function))
    expect(host.waitForTerminal).toHaveBeenCalledWith(
      'terminal-1',
      expect.objectContaining({ condition: 'exit' })
    )
    expect(host.unsubscribe).toHaveBeenCalledOnce()
  })

  it('reports a nonzero process exit and preserves its diagnostic output', async () => {
    const host = createHost()
    host.waitForTerminal.mockImplementation(async () => {
      host.emit('permission denied\n')
      host.emit(receipt(7))
      return exited(7)
    })
    expect(await observe(host)).toMatchObject({
      status: 'dispatch_failed',
      error: 'Automation process exited with code 7.',
      outputSnapshot: { content: 'permission denied' }
    })
    expect(host.unsubscribe).toHaveBeenCalledOnce()
  })

  it.each<WaitResult>([
    { satisfied: true },
    { satisfied: true, exitCode: null },
    { satisfied: true, exitCode: -1 },
    { satisfied: true, exitCode: -1, exitCause: { kind: 'operator_close' } },
    { satisfied: true, exitCode: -1, exitCause: { kind: 'signaled', signal: 9 } },
    { satisfied: true, exitCode: 0 },
    { satisfied: false, exitCode: 0, exitCause: { kind: 'exited', exitCode: 0 } },
    { satisfied: true, exitCode: 0, exitCause: { kind: 'unknown', reason: 'cause_unreported' } },
    {
      satisfied: true,
      exitCode: 0,
      exitCause: { kind: 'unknown', reason: 'host_status_unavailable' }
    }
  ])('hands unverifiable evidence back to the reconciler: %j', async (wait) => {
    vi.useFakeTimers()
    const host = createHost(['retained progress'])
    const unknown = vi.fn()
    host.waitForTerminal.mockResolvedValue(wait)
    await expect(
      observeShellRunCompletion(
        host.runtime,
        'terminal-1',
        run,
        new AbortController().signal,
        unknown
      )
    ).rejects.toThrow('automation_exit_unverifiable')
    expect(unknown).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: 'retained progress' })
    )
    expect(host.waitForTerminal).toHaveBeenCalledOnce()
    expect(host.unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each<WaitResult>([
    { satisfied: true, exitCode: 0, exitCause: { kind: 'signaled', signal: 9 } },
    { satisfied: true, exitCode: 0, exitCause: { kind: 'operator_close' } }
  ])('never reports interrupted execution as success: %j', async (wait) => {
    const host = createHost(['interrupted output'])
    host.waitForTerminal.mockResolvedValue(wait)
    const result = await observe(host)
    expect(result.status).toBe('dispatch_failed')
    expect(result.error).toMatch(/signal 9|closed before the command completed/)
    expect(result.outputSnapshot?.content).toBe('interrupted output')
    expect(host.unsubscribe).toHaveBeenCalledOnce()
  })

  it('preserves transport errors and output without inventing an execution failure', async () => {
    const host = createHost(['before disconnect'])
    const unknown = vi.fn()
    const error = new Error('connection_lost')
    host.waitForTerminal.mockRejectedValue(error)
    await expect(
      observeShellRunCompletion(
        host.runtime,
        'terminal-1',
        run,
        new AbortController().signal,
        unknown
      )
    ).rejects.toBe(error)
    expect(unknown).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: 'before disconnect' })
    )
    expect(host.unsubscribe).toHaveBeenCalledOnce()
  })

  it('can complete from proven exit evidence when the initial tail cannot be read', async () => {
    const host = createHost()
    host.readTerminal.mockRejectedValue(new Error('terminal_not_found'))
    expect(await observe(host, { ...run, terminalCommandExitCode: 0 })).toMatchObject({
      status: 'completed',
      outputSnapshot: null,
      error: null
    })
    expect(host.waitForTerminal).toHaveBeenCalledOnce()
    expect(host.unsubscribe).toHaveBeenCalledOnce()
  })

  it('unsubscribes when an active process wait is aborted', async () => {
    const host = createHost()
    const controller = new AbortController()
    const unknown = vi.fn()
    host.waitForTerminal.mockImplementation(
      (_handle, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('request_aborted')), {
            once: true
          })
        })
    )
    const observation = observeShellRunCompletion(
      host.runtime,
      'terminal-1',
      run,
      controller.signal,
      unknown
    )
    const aborted = expect(observation).rejects.toThrow('request_aborted')
    await Promise.resolve()
    await Promise.resolve()
    expect(host.waitForTerminal).toHaveBeenCalledOnce()
    controller.abort()
    await aborted
    expect(host.unsubscribe).toHaveBeenCalledOnce()
    expect(unknown).not.toHaveBeenCalled()
  })

  it('caps retained output at 256 Ki characters and marks older output as truncated', async () => {
    const host = createHost(['old output'])
    host.waitForTerminal.mockImplementation(async () => {
      host.emit(receipt(0))
      host.emit('x'.repeat(256 * 1024))
      host.emit('last line')
      return exited(0)
    })
    const result = await observe(host)
    expect(result.outputSnapshot?.content).toHaveLength(256 * 1024)
    expect(result.outputSnapshot?.content.endsWith('last line')).toBe(true)
    expect(result.outputSnapshot?.content).not.toContain('old output')
    expect(result.outputSnapshot?.truncated).toBe(true)
  })

  it('rejects a replacement incarnation before reading or subscribing', async () => {
    const host = createHost(['replacement output'])
    host.runtime.resolveTerminalPane = () => ({
      handle: 'terminal-1',
      ptyId: 'pty-1',
      incarnationId: 'replacement'
    })
    await expect(observe(host)).rejects.toThrow('terminal_incarnation_changed')
    expect(host.readTerminal).not.toHaveBeenCalled()
    expect(host.subscribeToTerminalData).not.toHaveBeenCalled()
    expect(host.waitForTerminal).not.toHaveBeenCalled()
  })

  it('preserves the truncation flag when recovering output from the saved run', async () => {
    const host = createHost()
    const retainedRun: AutomationRun = {
      ...run,
      terminalCommandExitCode: 0,
      outputSnapshot: {
        format: 'plain_text',
        content: 'retained tail',
        capturedAt: 1,
        truncated: true
      }
    }
    expect(await observe(host, retainedRun)).toMatchObject({
      status: 'completed',
      outputSnapshot: { content: 'retained tail', truncated: true }
    })
  })

  it('recovers the same incarnation through a new attempt with saved interim output', async () => {
    const host = createHost()
    const retainedRun: AutomationRun = { ...run }
    const unknown = vi.fn((snapshot: AutomationRun['outputSnapshot']) => {
      retainedRun.outputSnapshot = snapshot
    })
    host.waitForTerminal
      .mockImplementationOnce(async () => {
        host.emit('before disconnect\n')
        return { satisfied: true, exitCode: -1 }
      })
      .mockImplementationOnce(async () => {
        host.emit('after reconnect\n')
        host.emit(receipt(0))
        return exited(0)
      })
    await expect(
      observeShellRunCompletion(
        host.runtime,
        'terminal-1',
        run,
        new AbortController().signal,
        unknown
      )
    ).rejects.toThrow('automation_exit_unverifiable')
    expect(unknown).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: 'before disconnect' })
    )
    expect(host.unsubscribe).toHaveBeenCalledOnce()
    host.runtime.resolveTerminalPane = () => ({
      handle: 'terminal-2',
      ptyId: 'pty-1',
      incarnationId: 'incarnation-1'
    })
    expect(await observe(host, retainedRun)).toMatchObject({
      status: 'completed',
      outputSnapshot: { content: 'before disconnect\nafter reconnect', truncated: false }
    })
    expect(host.waitForTerminal).toHaveBeenNthCalledWith(
      2,
      'terminal-2',
      expect.objectContaining({ condition: 'exit' })
    )
    expect(host.unsubscribe).toHaveBeenCalledTimes(2)
  })
  it.each(['', receipt(0, 'another-run')])(
    'rejects missing or unrelated command receipts: %j',
    async (token) => {
      const host = createHost()
      host.waitForTerminal.mockImplementation(async () => {
        host.emit(token)
        return exited(0)
      })
      const onCommandExit = vi.fn()
      await expect(
        observeShellRunCompletion(
          host.runtime,
          'terminal-1',
          run,
          new AbortController().signal,
          undefined,
          onCommandExit
        )
      ).rejects.toThrow('automation_exit_unverifiable')
      expect(onCommandExit).not.toHaveBeenCalled()
      expect(host.unsubscribe).toHaveBeenCalledOnce()
    }
  )

  it('persists a matching command receipt even before host exit can be confirmed', async () => {
    const host = createHost()
    host.waitForTerminal.mockImplementation(async () => {
      host.emit(receipt(7))
      return { satisfied: true, exitCode: -1 }
    })
    const onCommandExit = vi.fn()
    await expect(
      observeShellRunCompletion(
        host.runtime,
        'terminal-1',
        run,
        new AbortController().signal,
        undefined,
        onCommandExit
      )
    ).rejects.toThrow('automation_exit_unverifiable')
    expect(onCommandExit).toHaveBeenCalledExactlyOnceWith(7)
    expect(host.unsubscribe).toHaveBeenCalledOnce()
  })

  it('uses the saved command exit status rather than a successful wrapper exit after recovery', async () => {
    const host = createHost()
    expect(await observe(host, { ...run, terminalCommandExitCode: 7 })).toMatchObject({
      status: 'dispatch_failed',
      error: 'Automation process exited with code 7.'
    })
  })

  it('recovers a matching command receipt from retained terminal output', async () => {
    const host = createHost(['retained command output', receipt(0)])
    expect(await observe(host)).toMatchObject({
      status: 'completed',
      outputSnapshot: { content: 'retained command output' }
    })
  })

  it.each(['terminal-1', 'renewed-terminal'])(
    'uses the host exit event across graph handle changes: %s',
    async (handle) => {
      const host = createConnectedHost()
      const onCommandExit = vi.fn()
      const observation = observeShellRunCompletion(
        host.runtime,
        'terminal-1',
        run,
        new AbortController().signal,
        undefined,
        onCommandExit
      )
      expect(host.subscribeToPtyExit).toHaveBeenCalledWith('pty-1', expect.any(Function))
      expect(host.subscribeToPtyExit.mock.invocationCallOrder[0]).toBeLessThan(
        host.subscribeToTerminalData.mock.invocationCallOrder[0] ?? Infinity
      )
      host.emit('before reload\n')
      await Promise.resolve()
      await Promise.resolve()
      expect(host.waitForTerminal).not.toHaveBeenCalled()
      host.terminal.handle = handle
      host.emit(`after reload\n${receipt(0)}`)
      expect(onCommandExit).toHaveBeenCalledExactlyOnceWith(0)
      expect(host.waitForTerminal).not.toHaveBeenCalled()
      expect(host.unsubscribe).not.toHaveBeenCalled()
      host.exit()
      expect(await observation).toMatchObject({
        status: 'completed',
        outputSnapshot: { content: 'before reload\nafter reload' }
      })
      expect(host.waitForTerminal).toHaveBeenCalledExactlyOnceWith(
        handle,
        expect.objectContaining({ condition: 'exit' })
      )
      expect(host.subscribeToTerminalData).toHaveBeenCalledOnce()
      expect(host.unsubscribe).toHaveBeenCalledOnce()
      expect(host.unsubscribeExit).toHaveBeenCalledOnce()
    }
  )

  it('disposes output and exit subscriptions when observation is aborted during execution', async () => {
    const host = createConnectedHost()
    const controller = new AbortController()
    const observation = observeShellRunCompletion(
      host.runtime,
      'terminal-1',
      run,
      controller.signal
    )
    const aborted = expect(observation).rejects.toThrow('request_aborted')
    await Promise.resolve()
    await Promise.resolve()
    expect(host.waitForTerminal).not.toHaveBeenCalled()
    controller.abort()
    await aborted
    expect(host.waitForTerminal).not.toHaveBeenCalled()
    expect(host.unsubscribe).toHaveBeenCalledOnce()
    expect(host.unsubscribeExit).toHaveBeenCalledOnce()
  })

  it('refuses a verdict for a replacement incarnation after the exit event', async () => {
    const host = createConnectedHost()
    const onCommandExit = vi.fn()
    const observation = observeShellRunCompletion(
      host.runtime,
      'terminal-1',
      run,
      new AbortController().signal,
      undefined,
      onCommandExit
    )
    const rejected = expect(observation).rejects.toThrow('terminal_incarnation_changed')
    await Promise.resolve()
    await Promise.resolve()
    host.terminal.incarnationId = 'replacement-incarnation'
    host.emit(receipt(0))
    host.exit()
    await rejected
    expect(onCommandExit).not.toHaveBeenCalled()
    expect(host.waitForTerminal).not.toHaveBeenCalled()
    expect(host.unsubscribe).toHaveBeenCalledOnce()
    expect(host.unsubscribeExit).toHaveBeenCalledOnce()
  })

  it('reads an already-ended process verdict without waiting for a new exit event', async () => {
    const host = createConnectedHost()
    host.terminal.connected = false
    expect(await observe(host, { ...run, terminalCommandExitCode: 0 })).toMatchObject({
      status: 'completed'
    })
    expect(host.waitForTerminal).toHaveBeenCalledOnce()
    expect(host.unsubscribeExit).toHaveBeenCalledOnce()
  })
})
