import type { AgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { StructuredAgentSessionHostDeps as HostDeps } from '../host/structured-agent-session-host-types'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { sendStructuredAgentSessionTurn } from '../operations/structured-agent-session-host-mutations'
import type { UsageLimitCutReads } from './structured-agent-session-usage-limit-cold-cuts'

export type UsageLimitContinueDeps = UsageLimitCutReads & {
  host: Pick<HostDeps, 'usageLimitAutoContinue' | 'logger' | 'launchAccountHome'> & {
    store: Pick<
      AgentSessionRecordStore,
      | 'listVisibleSessionIds'
      | 'getRecord'
      | 'hostId'
      | 'isSessionTabVisible'
      | 'listBackgroundSessionIds'
      | 'isSessionInBackground'
      | 'cancelUsageLimitContinue'
    >
  }
  serialize: <T>(id: string, run: () => Promise<T>) => Promise<T>
  send: (
    params: Parameters<typeof sendStructuredAgentSessionTurn>[2]
  ) => ReturnType<typeof sendStructuredAgentSessionTurn>
  publish: (id: string) => void
  now: () => number
  /** Whether the chat's running agent still owes work on the account it is leaving. */
  awaitsAccountMove?: (
    id: string,
    launchHome?: () => Promise<AgentSessionAccountHome | null>
  ) => Promise<boolean>
  /** The sweep no longer waits on the chat's move. */
  stopsAwaitingAccountMove?: (id: string) => void
}
