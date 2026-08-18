import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import type { StructuredAgentSessionHandoffTransport } from './structured-agent-session-handoff-types'

export type StructuredAgentSessionCaller = { callerKey: string }

export type StructuredAgentSessionHostSession = {
  journal: AgentSessionJournal
  params: AgentSessionAttachParams
  fence: number
}

export type StructuredAgentSessionHostDeps = {
  store: AgentSessionRecordStore
  adapter: StructuredAgentSessionAdapter
  journalRoot: string
  claimKeyId: string
  probeOwner?: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
  /** Recovery-exit stop requests only; a lease moves only on a later proven-absent probe. */
  stopOwnerProcess?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  mintSpawnToken?: () => string
  resolveLaunchEnv?: (
    provider: AgentSessionRecord['provider']
  ) => Promise<Record<string, string> | undefined> | Record<string, string> | undefined
  now?: () => number
  onEventSinkError?: (input: { sessionId: string; error: unknown }) => void
  handoffTransport?: StructuredAgentSessionHandoffTransport
}
