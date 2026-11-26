import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import type { TerminalWaiter } from './terminal-waiter'
import { buildPtyTerminalWaitExitError, getPtyTerminalState } from './terminal-wait-results'
import type { RuntimeTerminalWaiterRegistry } from './terminal-waiter-registry'

export type TerminalInputCustody = {
  target: RuntimePtyWorktreeRecord
  /** Aborted when the process ends, is replaced or pruned, or the caller aborts; the operation may abort it too. */
  stop: AbortController
  /** Throws once the process ended, was replaced or pruned, or the caller aborted. */
  assertLive: () => void
  /** Throws unless the operation is live and the captured process still owns its PTY; call right before each write. */
  assertOriginal: () => void
}

/** Holds input for one process from capture to its last write; `outlivesRenderer` keeps it through window detachment. */
export async function holdTerminalInputCustody<T>(
  {
    handle,
    target,
    readTarget,
    waiters,
    signal,
    outlivesRenderer
  }: {
    handle: string
    target: RuntimePtyWorktreeRecord
    /** The record that owns the PTY now; a handle-bound read throws once the handle is gone. */
    readTarget: () => RuntimePtyWorktreeRecord | undefined
    waiters: RuntimeTerminalWaiterRegistry
    signal?: AbortSignal
    outlivesRenderer?: true
  },
  deliver: (custody: TerminalInputCustody) => Promise<T>
): Promise<T> {
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
  // The wait registry retires this exact operation on exit, replacement and prune, and on graph retirement unless it outlives the renderer.
  const observer: TerminalWaiter = {
    handle,
    ptyId: target.ptyId,
    condition: 'exit',
    resolve: () => endObservation(buildPtyTerminalWaitExitError(target)),
    reject: endObservation,
    timeout: null,
    cancelIdlePoll: null,
    abortCleanup: null,
    ...(outlivesRenderer ? { outlivesRenderer } : {})
  }
  waiters.add(observer)
  const onAbort = (): void => stop.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const assertLive = (): void => {
    if (lifetimeError) {
      throw lifetimeError
    }
    if (signal?.aborted) {
      throw new Error('request_aborted')
    }
  }
  const assertOriginal = (): void => {
    assertLive()
    const pty = readTarget()
    if (pty !== target || (incarnationId !== null && pty.incarnationId !== incarnationId)) {
      throw new Error('terminal_handle_stale')
    }
    if (getPtyTerminalState(pty) === 'exited') {
      throw buildPtyTerminalWaitExitError(pty)
    }
    if (!pty.connected) {
      throw new Error('terminal_handle_stale')
    }
  }
  try {
    return await deliver({ target, stop, assertLive, assertOriginal })
  } finally {
    stop.abort()
    signal?.removeEventListener('abort', onAbort)
    waiters.remove(observer)
  }
}
