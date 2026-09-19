import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import {
  refreshRecoverableStructuredSession,
  retireProbedStructuredSessionOwner
} from './structured-agent-session-owner-observation'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'

export function createStructuredSessionRuntimeMaintenance(
  deps: StructuredAgentSessionHostDeps,
  access: {
    sessions: Map<string, StructuredAgentSessionHostSession>
    delivery: StructuredAgentSessionClientDelivery
    now: () => number
    serialize: (sessionId: string, task: () => Promise<void>) => Promise<void>
    restoreRenewed: (sessionId: string) => Promise<void>
    reveal: (sessionId: string) => Promise<unknown>
    recoverTui: (sessionId: string, fence: number, probe: AgentSessionOwnerProbe) => Promise<void>
    sinkFailed: (sessionId: string, error: unknown) => void
  }
): StructuredAgentSessionHostRuntimeState {
  const context = { deps, sessions: access.sessions, delivery: access.delivery, now: access.now }
  const runtime = new StructuredAgentSessionHostRuntimeState(
    deps,
    (record) => access.restoreRenewed(record.sessionId),
    (record, probe) =>
      access.sessions.has(record.sessionId)
        ? access.serialize(record.sessionId, () =>
            access.recoverTui(record.sessionId, record.lease.runtimeFence, probe)
          )
        : Promise.resolve(),
    access.sinkFailed,
    async (record) => {
      if (!access.sessions.has(record.sessionId)) {
        await access.reveal(record.sessionId)
      }
      await access.serialize(record.sessionId, () =>
        refreshRecoverableStructuredSession({ ...context, record, runtime })
      )
    },
    (record, probe) =>
      access.serialize(record.sessionId, () =>
        retireProbedStructuredSessionOwner({ ...context, record, probe, runtime })
      ),
    (record) => access.delivery.publishStatus(record.sessionId)
  )
  return runtime
}
