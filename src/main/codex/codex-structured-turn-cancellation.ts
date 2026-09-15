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
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-contracts'
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

function turnKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId])
}

type TurnCancellationDeps = Pick<
  CodexStructuredSessionAdapterDeps,
  'captureTurnProcesses' | 'requestTimeoutMs' | 'terminateTurnProcesses'
> & {
  emit: (
    session: CodexSession,
    event: CodexStructuredSessionEvent
  ) => CodexJournalTranslationAdmission
}

const ADMITTED: CodexJournalTranslationAdmission = { accepted: true }

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

    if (!key || !state.blockedCompletions.has(key)) {
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

    return true
  }

  async cancel(
    session: CodexSession,
    threadId: string,
    turnId: string,
    isCurrent: () => boolean = () => true,
    onConfirmed?: () => CodexJournalTranslationAdmission
  ): Promise<{ cancelled: boolean }> {
    const state = this.state(session)
    const key = turnKey(threadId, turnId)
    state.blockedCompletions.add(key)
    const targetsPrimaryTurn = threadId === session.threadId
    const baseline = targetsPrimaryTurn ? await state.baseline : null

    if (!isCurrent()) {
      this.releaseCompletion(session, key)

      return { cancelled: false }
    }

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
      targetsPrimaryTurn ? this.terminate(session.connection, baseline) : Promise.resolve(true)
    ])

    if (terminated && acknowledged) {
      const completion = state.deferredCompletions.get(key)
      let confirmationError: unknown
      let promptAdmission = ADMITTED

      try {
        promptAdmission = onConfirmed?.() ?? ADMITTED
      } catch (error) {
        confirmationError = error
      }

      const completionAdmission = this.releaseCompletion(session, key, completion)

      if (confirmationError) {
        throw confirmationError
      }

      if (!promptAdmission.accepted) {
        throw new Error(
          `Codex prompt cancellation lifecycle was not admitted (${promptAdmission.reason})`
        )
      }

      if (onConfirmed && completion && !completionAdmission.accepted) {
        throw new Error(
          `Codex deferred turn completion lifecycle was not admitted (${completionAdmission.reason})`
        )
      }

      return { cancelled: true }
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

  private releaseCompletion(
    session: CodexSession,
    key: string,
    completion = this.state(session).deferredCompletions.get(key)
  ): CodexJournalTranslationAdmission {
    const state = this.state(session)
    state.blockedCompletions.delete(key)
    state.deferredCompletions.delete(key)

    return completion ? this.deps.emit(session, completion) : ADMITTED
  }

  private state(session: CodexSession): TurnProcessState {
    const state = this.states.get(session)

    if (!state) {
      throw new Error('codex turn process state is unavailable')
    }

    return state
  }
}
