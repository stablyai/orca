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

type TurnProcessState = {
  baseline: Promise<CodexTurnProcessSnapshot | null>
  blockedCompletions: Set<string>
  deferredCompletions: Map<string, CodexStructuredSessionEvent>
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
      deferredCompletions: new Map()
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
    params: unknown
  ): boolean {
    const threadId = readCodexThreadId(params) ?? session.threadId
    if (method !== 'turn/completed' || threadId !== session.threadId) {
      return false
    }
    const turnId = readCodexTurnId(params)
    const state = this.state(session)
    if (!turnId || !state.blockedCompletions.has(turnId)) {
      return false
    }
    const event = {
      type: 'notification' as const,
      sessionId,
      threadId,
      method,
      params
    }
    state.deferredCompletions.set(turnId, event)
    return true
  }

  async cancel(session: CodexSession, turnId: string): Promise<{ cancelled: boolean }> {
    const state = this.state(session)
    state.blockedCompletions.add(turnId)
    const baseline = await state.baseline
    let requestError: unknown
    const interruptReceipt = session.connection
      .request(
        'turn/interrupt',
        { threadId: session.threadId, turnId },
        { timeoutMs: this.deps.requestTimeoutMs }
      )
      .then(
        () => true,
        (error: unknown) => {
          requestError = error
          return false
        }
      )
    const [acknowledged, terminated] = await Promise.all([
      interruptReceipt,
      this.terminate(session.connection, baseline)
    ])
    if (terminated && acknowledged) {
      this.releaseCompletion(session, turnId)
      return { cancelled: true }
    }
    if (
      requestError &&
      !isCodexAppServerRequestError(requestError) &&
      !isCodexAppServerUnsupportedError(requestError)
    ) {
      this.releaseCompletion(session, turnId)
      throw requestError
    }
    // A failed cancellation must not permanently divert the provider's later
    // completion for this turn. Let the normal completion path settle it.
    this.releaseCompletion(session, turnId)
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

  private releaseCompletion(
    session: CodexSession,
    turnId: string,
    completion = this.state(session).deferredCompletions.get(turnId)
  ): void {
    const state = this.state(session)
    state.blockedCompletions.delete(turnId)
    state.deferredCompletions.delete(turnId)
    if (completion) {
      this.deps.emit(session, completion)
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
