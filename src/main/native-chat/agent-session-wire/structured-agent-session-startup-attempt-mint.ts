import { randomUUID } from 'node:crypto'
import type { ClaudeAccountRecipe } from '../../../shared/agent-session-acquired-account'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-identity'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentChatPermissionChoice } from '../../../shared/agent-chat-permission-mode'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { StructuredAgentSessionStartupAttempt } from './structured-agent-session-startup-attempt-contract'

export function mintStructuredAgentSessionStartupAttempt(input: {
  record: AgentSessionRecord
  identity: AgentSessionJournalIdentity
  spawnToken: string
  permissionMode?: AgentChatPermissionChoice
  accountRecipe?: ClaudeAccountRecipe
  events?: StructuredAgentSessionEventSink
  signal?: AbortSignal
  startupOptions?: Readonly<Record<string, string>>
  attemptId?: string
}): StructuredAgentSessionStartupAttempt {
  const { record } = input
  const selected = input.startupOptions ?? record.options
  const options = record.provider === 'claude' ? { fastMode: 'false', ...selected } : selected
  return {
    attemptId: input.attemptId ?? randomUUID(),
    identity: input.identity,
    fence: record.lease.runtimeFence,
    spawnToken: input.spawnToken,
    launch: {
      location: record.location,
      accountHome: record.accountHome,
      ...(record.launchDirectory === undefined ? {} : { launchDirectory: record.launchDirectory })
    },
    ...(options ? { options } : {}),
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    ...(input.accountRecipe ? { accountRecipe: input.accountRecipe } : {}),
    ...(input.events ? { events: input.events } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  }
}
