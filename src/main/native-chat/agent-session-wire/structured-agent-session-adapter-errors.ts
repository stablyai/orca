import type { AgentSessionAccountKind } from '../../../shared/agent-session-availability'
import type { AgentSessionRefusalReason } from '../../../shared/agent-session-wire-refusals'

// Errors an adapter throws to the host; kept apart so the adapter contract file stays the contract.

export class AgentSessionAcquisitionRefusal extends Error {
  readonly code = 'agent_session_operation_invalid'

  constructor(
    message: string,
    /** UI refusal reason; message stays in logs. Defaults to providerStartFailed. */
    readonly reason: AgentSessionRefusalReason<'agent_session_operation_invalid'> = 'providerStartFailed',
    readonly account?: AgentSessionAccountKind
  ) {
    super(message)
    this.name = 'AgentSessionAcquisitionRefusal'
  }

  static historyTooLarge(message: string): AgentSessionAcquisitionRefusal {
    return new AgentSessionAcquisitionRefusal(message, 'historyTooLarge')
  }
}

export class AgentSessionPromptUnavailableError extends Error {
  constructor(itemId: string) {
    super(`The provider is no longer waiting on ${itemId}.`)
    this.name = 'AgentSessionPromptUnavailableError'
  }
}

/** Reject before journal commit when a provider reply cannot be constructed. */
export class AgentSessionPromptAnswerRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentSessionPromptAnswerRejectedError'
  }
}

export type AgentSessionPreSpawnReason = Extract<
  AgentSessionRefusalReason<'agent_session_operation_invalid'>,
  | 'managedAccountEnvOverride'
  | 'accountSwitchInProgress'
  | 'managedAccountUnsupported'
  | 'launchFolderMissing'
  | 'historyInOtherAccount'
  | 'claudeAccountFolderMissing'
  | 'claudeAccountSetupFailed'
  | 'agentCommandNotRunnable'
  | 'runtimeNotInstalled'
>

/** First-hand proof that acquisition spawned no process. */
export class AgentSessionPreSpawnError extends Error {
  /** Absent reasons are log-only; wrapped pre-spawn errors retain theirs. */
  readonly reason: AgentSessionPreSpawnReason | undefined

  constructor(
    cause: unknown,
    options: { reason?: AgentSessionPreSpawnReason; message?: string } = {}
  ) {
    super(options.message ?? (cause instanceof Error ? cause.message : String(cause)), { cause })
    this.name = 'AgentSessionPreSpawnError'
    this.reason = options.reason ?? (isAgentSessionPreSpawnError(cause) ? cause.reason : undefined)
  }
}

export function isAgentSessionPreSpawnError(error: unknown): error is AgentSessionPreSpawnError {
  return error instanceof Error && error.name === 'AgentSessionPreSpawnError'
}
