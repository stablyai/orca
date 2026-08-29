import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionSpawnTokenScan } from '../../runtime/agent-session-spawn-token-process-scan'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import type { StructuredAgentSessionHandoffTransport } from './structured-agent-session-handoff-types'

export type StructuredAgentSessionCaller = { callerKey: string }

export type StructuredAgentSessionHostSession = {
  journal: AgentSessionJournal
  params: AgentSessionAttachParams
  fence: number
  /** Whether THIS host generation is running the provider process behind the session. A journal
   *  restored for reading has none, and neither has a session a TUI owns — so neither may be
   *  evicted to free a child, and neither may have its lease released as an observed exit. */
  hasProviderChild: boolean
}

export type StructuredAgentSessionHostDeps = {
  store: AgentSessionRecordStore
  adapter: StructuredAgentSessionAdapter
  journalRoot: string
  claimKeyId: string
  probeOwner?: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
  probeOwners?: (
    records: readonly AgentSessionRecord[]
  ) => Promise<Map<string, AgentSessionOwnerProbe>>
  /** Recovery-exit stop requests only; a lease moves only on a later proven-absent probe. */
  stopOwnerProcess?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  /** Host spawn-token process scan; null means the platform cannot enumerate, never "none". */
  scanSpawnTokenProcesses?: () => Promise<AgentSessionSpawnTokenScan | null>
  mintSpawnToken?: () => string
  resolveLaunchArgs?: (
    provider: AgentSessionRecord['provider']
  ) => Promise<string[] | undefined> | string[] | undefined
  resolveLaunchEnv?: (
    provider: AgentSessionRecord['provider']
  ) => Promise<Record<string, string> | undefined> | Record<string, string> | undefined
  now?: () => number
  persistTuiProviderHandle?: (input: {
    sessionId: string
    link: AgentSessionProviderHandleLink
    now: number
  }) => Promise<void>
  /** How long a session outlives its last surface. Tests drive this; production takes the default. */
  releaseGraceMs?: number
  onEventSinkError?: (input: { sessionId: string; error: unknown }) => void
  handoffTransport?: StructuredAgentSessionHandoffTransport
}
