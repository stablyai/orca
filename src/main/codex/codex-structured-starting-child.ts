import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { CodexStructuredSessionAdapterDeps } from './codex-structured-session-state'

export function codexStartupFailureFact(
  failure: Error,
  requestedClose: boolean,
  exitError?: Error
) {
  return requestedClose
    ? agentSessionFailureFact('hostFault')
    : failure instanceof AgentSessionAcquisitionRefusal && failure.reason === 'historyTooLarge'
      ? agentSessionFailureFact('historyTooLarge')
      : agentSessionFailureFact('providerExited', {
          detail: providerDiagnosticOf(failure) ?? providerDiagnosticOf(exitError)
        })
}

/** Owns the process during startup, before a thread exists to put in the ready-session map. */
export class CodexStartingChild {
  ended = false
  initializeAnswered = false
  failure: Error | undefined

  constructor(
    readonly acquisitionGeneration: string,
    private readonly input: {
      sessionId: string
      fence: number
      onEvent: CodexStructuredSessionAdapterDeps['onEvent']
      dispose: () => void
    }
  ) {}

  end(error: Error, requestedClose = false): void {
    if (this.ended) {
      return
    }
    this.ended = true
    const failure = this.failure ?? error
    this.input.dispose()
    this.input.onEvent?.({
      type: 'ended',
      sessionId: this.input.sessionId,
      fence: this.input.fence,
      acquisitionGeneration: this.acquisitionGeneration,
      reason: failure.message,
      cause: requestedClose ? 'requested-close' : 'unexpected-exit',
      failure: codexStartupFailureFact(failure, requestedClose, error),
      observedAt: Date.now(),
      startupUnproven: true,
      ...(!this.initializeAnswered ? { startupUnanswered: true } : {})
    })
  }
}
