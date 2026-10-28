import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { performSend } from './structured-agent-session-turns'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type { reserveRequestFor } from './structured-agent-session-attach'

export type StructuredAgentSessionCreateOptions = {
  firstMessage?: { clientMessageId: string; body: AgentJournalMessageItem }
  hostLaunchDirectory?: string
  catalogModels?: Parameters<typeof reserveRequestFor>[0]['models']
  /** Publish after durable creation, before agent delivery starts. */
  publishTab?: () => Promise<void>
}

/** Opening messages retain creation-time model/effort choices like later sends. */
export function openingMessageOptions(options: Readonly<Record<string, string>> | undefined): {
  options?: AgentSessionExecutionOptions
} {
  const { model, effort } = options ?? {}
  return model ? { options: { model, ...(effort ? { effort } : {}) } } : {}
}

export function openingMessageParams(
  sessionId: string,
  firstMessage: NonNullable<StructuredAgentSessionCreateOptions['firstMessage']>,
  options: Readonly<Record<string, string>> | undefined
): Parameters<typeof performSend>[1] {
  return {
    ...firstMessage,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId,
      fields: { body: firstMessage.body }
    }),
    origin: 'client',
    source: { kind: 'user' },
    ...openingMessageOptions(options)
  }
}
