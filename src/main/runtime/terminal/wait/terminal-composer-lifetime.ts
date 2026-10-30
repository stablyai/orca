import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { TerminalWaiter } from '../../runtime-terminal-contracts'
import { buildPtyTerminalWaitExitError, getPtyTerminalState } from '../../terminal-wait-results'
import type { RuntimeTerminalWaiterRegistry } from './terminal-waiter-registry'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-terminal-contracts'

export async function waitForTerminalComposer(
  {
    handle,
    getTarget,
    buildResult,
    waiters,
    signal
  }: {
    handle: string
    getTarget: () => RuntimePtyWorktreeRecord
    buildResult: () => RuntimeTerminalWait
    waiters: RuntimeTerminalWaiterRegistry
    signal?: AbortSignal
  },
  observe: (target: RuntimePtyWorktreeRecord, stop: AbortController) => Promise<string | null>
): Promise<RuntimeTerminalWait> {
  const target = getTarget()
  if (getPtyTerminalState(target) === 'exited') {
    throw buildPtyTerminalWaitExitError(target)
  }
  if (signal?.aborted) {
    throw new Error('request_aborted')
  }
  const incarnationId = target.incarnationId
  const stop = new AbortController()
  let lifetimeError: Error | undefined
  const endObservation = (error: Error): void => {
    if (!stop.signal.aborted) {
      lifetimeError = error
      stop.abort()
    }
  }
  // The existing wait registry retires this exact operation on exit, replacement, prune and graph retirement.
  const observer: TerminalWaiter = {
    handle,
    ptyId: target.ptyId,
    condition: 'exit',
    resolve: () => endObservation(buildPtyTerminalWaitExitError(target)),
    reject: endObservation,
    timeout: null,
    cancelIdlePoll: null,
    abortCleanup: null
  }
  waiters.add(observer)
  const onAbort = (): void => stop.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const ptyId = await observe(target, stop)
    if (lifetimeError) {
      throw lifetimeError
    }
    if (!ptyId) {
      throw new Error(
        signal?.aborted
          ? 'request_aborted'
          : stop.signal.aborted
            ? 'agent_startup_dialog'
            : 'timeout'
      )
    }
    const pty = getTarget()
    if (pty !== target || (incarnationId !== null && pty.incarnationId !== incarnationId)) {
      throw new Error('terminal_handle_stale')
    }
    if (getPtyTerminalState(pty) === 'exited') {
      throw buildPtyTerminalWaitExitError(pty)
    }
    if (!pty.connected) {
      throw new Error('terminal_handle_stale')
    }
    return buildResult()
  } finally {
    stop.abort()
    signal?.removeEventListener('abort', onAbort)
    waiters.remove(observer)
  }
}
