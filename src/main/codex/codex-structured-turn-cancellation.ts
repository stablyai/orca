import {
  isCodexAppServerRequestError,
  type CodexAppServerConnection
} from './codex-app-server-connection'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import type {
  CodexSession,
  CodexStructuredSessionAdapterDeps,
  CodexStructuredSessionEvent
} from './codex-structured-session-state'
import { readCodexThreadId, readCodexTurnId } from './codex-structured-thread-facts'
import {
  captureCodexTurnProcesses,
  terminateCodexTurnProcesses,
  type CodexTurnProcessSnapshot
} from './codex-structured-turn-processes'

const DEFAULT_CODEX_TURN_CANCELLATION_TIMEOUT_MS = 30_000

type TurnProcessState = {
  baseline: Promise<CodexTurnProcessSnapshot | null>
  blockedCompletions: Set<string>
  deferredCompletions: Map<string, CodexStructuredSessionEvent>
  completionWaiters: Map<string, Set<(completed: boolean) => void>>
  providerConfirmed: Set<string>
  settlements: Map<string, { settlementId: string; resolvedBy?: string; resolvedAt?: number }>
  completionCallbacks: Map<string, () => void>
}

type TurnCancellationDeps = Pick<
  CodexStructuredSessionAdapterDeps,
  'captureTurnProcesses' | 'requestTimeoutMs' | 'terminateTurnProcesses'
> & {
  emit: (session: CodexSession, event: CodexStructuredSessionEvent) => void
}

export class CodexStructuredTurnCancellation {
  private readonly states = new WeakMap<CodexSession, TurnProcessState>()

  constructor(private readonly deps: TurnCancellationDeps) {}

  register(session: CodexSession): void {
    this.states.set(session, {
      baseline: Promise.resolve(null),
      blockedCompletions: new Set(),
      deferredCompletions: new Map(),
      completionWaiters: new Map(),
      providerConfirmed: new Set(),
      settlements: new Map(),
      completionCallbacks: new Map()
    })
  }

  captureBaseline(session: CodexSession): Promise<CodexTurnProcessSnapshot | null> {
    this.refreshBaseline(session)
    return this.state(session).baseline
  }

  handleNotification(
    sessionId: string,
    session: CodexSession,
    method: string,
    params: unknown,
    observedAt?: number
  ): boolean {
    const threadId = readCodexThreadId(params) ?? session.threadId
    if (method !== 'turn/completed') {
      return false
    }
    const turnId = readCodexTurnId(params)
    const state = this.state(session)
    const key = turnId ? turnKey(threadId, turnId) : null
    if (!turnId || !key || !state.blockedCompletions.has(key)) {
      return false
    }
    const event = {
      type: 'notification' as const,
      sessionId,
      threadId,
      method,
      params,
      ...(observedAt !== undefined ? { observedAt } : {})
    }
    state.deferredCompletions.set(key, event)
    for (const resolve of state.completionWaiters.get(key) ?? []) {
      resolve(true)
    }
    if (state.providerConfirmed.has(key)) {
      this.releaseCompletion(session, key, event)
    }
    return true
  }

  async cancel(
    session: CodexSession,
    threadId: string,
    turnId: string,
    settlement?: { settlementId: string; resolvedBy?: string; resolvedAt?: number },
    onCompletion?: () => void
  ): Promise<{ cancelled: boolean }> {
    const state = this.state(session)
    const key = turnKey(threadId, turnId)
    state.blockedCompletions.add(key)
    if (settlement && !state.settlements.has(key)) {
      state.settlements.set(key, settlement)
    }
    if (onCompletion && !state.completionCallbacks.has(key)) {
      state.completionCallbacks.set(key, onCompletion)
    }
    const primaryTurn = threadId === session.threadId
    const requireCompletion = !primaryTurn || settlement !== undefined
    const ownsConfirmation =
      !settlement || state.settlements.get(key)?.settlementId === settlement.settlementId
    const completionReceipt = requireCompletion
      ? this.waitForCompletion(session, key)
      : Promise.resolve(true)
    if (state.providerConfirmed.has(key)) {
      const completed = await completionReceipt
      if (!completed) {
        throw new CodexTurnCompletionPendingError()
      }
      this.releaseCompletion(session, key)
      return { cancelled: ownsConfirmation }
    }
    const baseline = primaryTurn ? await state.baseline : null
    let requestError: unknown
    const interruptReceipt = session.connection
      .request('turn/interrupt', { threadId, turnId }, { timeoutMs: this.deps.requestTimeoutMs })
      .then(
        () => true,
        (error: unknown) => {
          requestError = error
          return false
        }
      )
    const [acknowledged, terminated] = await Promise.all([
      interruptReceipt,
      primaryTurn ? this.terminate(session.connection, baseline) : Promise.resolve(true)
    ])
    const completed = acknowledged && terminated ? await completionReceipt : false
    if (completed && acknowledged && terminated) {
      state.providerConfirmed.add(key)
      this.releaseCompletion(session, key)
      return { cancelled: true }
    }
    if (acknowledged && terminated) {
      state.providerConfirmed.add(key)
      if (state.deferredCompletions.has(key)) {
        this.releaseCompletion(session, key)
        return { cancelled: true }
      }
      throw new CodexTurnCompletionPendingError()
    }
    if (
      requestError &&
      !isCodexAppServerRequestError(requestError) &&
      !isCodexAppServerUnsupportedError(requestError)
    ) {
      this.releaseCompletion(session, key)
      throw requestError
    }
    // A failed cancellation must not permanently divert the provider's later
    // completion for this turn. Let the normal completion path settle it.
    this.releaseCompletion(session, key)
    return { cancelled: false }
  }

  private capture(pid: number | undefined): Promise<CodexTurnProcessSnapshot | null> {
    return pid
      ? (this.deps.captureTurnProcesses ?? captureCodexTurnProcesses)(pid)
      : Promise.resolve(null)
  }

  private terminate(
    connection: Pick<CodexAppServerConnection, 'pid'>,
    baseline: CodexTurnProcessSnapshot | null
  ): Promise<boolean> {
    return connection.pid
      ? (this.deps.terminateTurnProcesses ?? terminateCodexTurnProcesses)(connection.pid, baseline)
      : Promise.resolve(false)
  }

  private refreshBaseline(session: CodexSession): void {
    this.state(session).baseline = this.capture(session.connection.pid)
  }

  private waitForCompletion(session: CodexSession, key: string): Promise<boolean> {
    const state = this.state(session)
    if (state.deferredCompletions.has(key)) {
      return Promise.resolve(true)
    }
    return new Promise<boolean>((resolve) => {
      const waiters = state.completionWaiters.get(key) ?? new Set()
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | null = setTimeout(
        () => finish(false),
        this.deps.requestTimeoutMs ?? DEFAULT_CODEX_TURN_CANCELLATION_TIMEOUT_MS
      )
      const finish = (completed: boolean): void => {
        if (settled) {
          return
        }
        settled = true
        if (timeout) {
          clearTimeout(timeout)
          timeout = null
        }
        waiters.delete(finish)
        if (waiters.size === 0) {
          state.completionWaiters.delete(key)
        }
        resolve(completed)
      }
      waiters.add(finish)
      state.completionWaiters.set(key, waiters)
    })
  }

  private releaseCompletion(
    session: CodexSession,
    key: string,
    completion = this.state(session).deferredCompletions.get(key)
  ): void {
    const state = this.state(session)
    const deliveredCompletion =
      completion && state.providerConfirmed.has(key)
        ? { ...completion, ...state.settlements.get(key) }
        : completion
    state.blockedCompletions.delete(key)
    state.deferredCompletions.delete(key)
    for (const resolve of state.completionWaiters.get(key) ?? []) {
      resolve(completion !== undefined)
    }
    state.completionWaiters.delete(key)
    state.providerConfirmed.delete(key)
    state.settlements.delete(key)
    const onCompletion = state.completionCallbacks.get(key)
    state.completionCallbacks.delete(key)
    if (deliveredCompletion) {
      this.deps.emit(session, deliveredCompletion)
      onCompletion?.()
    }
  }

  private state(session: CodexSession): TurnProcessState {
    const state = this.states.get(session)
    if (!state) {
      throw new Error('codex turn process state is unavailable')
    }
    return state
  }
}

class CodexTurnCompletionPendingError extends Error {
  constructor() {
    super('Codex confirmed the interruption; the completion record is still pending.')
  }
}

function turnKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId])
}
