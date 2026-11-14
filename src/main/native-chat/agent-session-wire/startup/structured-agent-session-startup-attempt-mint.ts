import { randomUUID } from 'node:crypto'
import { effectiveAgentSessionOptions } from '../../../../shared/agent-session-default-model'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentChatPermissionChoice } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { StructuredAgentSessionEventSink } from '../journal-ingress/structured-agent-session-event-sink'
import type { StructuredAgentSessionStartupAttempt } from './structured-agent-session-startup-attempt-contract'

export function mintStructuredAgentSessionStartupAttempt(input: {
  record: AgentSessionRecord
  identity: AgentSessionJournalIdentity
  spawnToken: string
  permissionMode?: AgentChatPermissionChoice
  events?: StructuredAgentSessionEventSink
  signal?: AbortSignal
  startupOptions?: Readonly<Record<string, string>>
  attemptId?: string
}): StructuredAgentSessionStartupAttempt {
  const { record } = input
  const selected = input.startupOptions ?? effectiveAgentSessionOptions(record)
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
    ...(input.events ? { events: input.events } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  }
}
