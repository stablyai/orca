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
      | 'cancelUsageLimitContinue'
    >
  }
  serialize: <T>(id: string, run: () => Promise<T>) => Promise<T>
  send: (
    params: Parameters<typeof sendStructuredAgentSessionTurn>[2]
  ) => ReturnType<typeof sendStructuredAgentSessionTurn>
  publish: (id: string) => void
  now: () => number
}
