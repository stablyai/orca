import { defineMethod } from '../../../core'
import { OptionsParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { AgentSessionRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-record'
import { isNativeLocalLocation } from '../../../../../../shared/execution-host'
import { usageBuildHash } from '../../../../agent-session/records/agent-session-execution-runtime'
import type { AgentSessionUsageSnapshot } from '../../../../../../shared/agent-session/agent-session-usage-meter'

function custody(record: AgentSessionRecord): string {
  const { leaseDeadlineAt: _deadline, lastRenewedAt: _renewed, ...lease } = record.lease
  return JSON.stringify([
    record.sessionId,
    record.schemaVersion,
    record.provider,
    record.location,
    record.accountHome,
    record.providerHandleChain,
    lease
  ])
}

export const STRUCTURED_AGENT_SESSION_USAGE_SNAPSHOT_METHODS = [
  defineMethod({
    name: 'agentSession.usageSnapshot',
    permission: 'workspace',
    params: OptionsParams,
    handler: async ({ sessionId }, ctx): Promise<AgentSessionUsageSnapshot> => {
      const host = await requireInstalledStructuredHost(ctx, sessionId)
      const record = host.deps.store.getRecord(sessionId)
      const adapter = record && host.deps.agents.registration(record.provider)?.adapter
      if (!record || !isNativeLocalLocation(record.location) || !adapter?.readUsageMeter) {
        return { status: 'unknown', reason: 'unsupported' }
      }
      const runtimeId = ctx.runtime.getRuntimeId()
      const owner = record.lease.ownerProcess
      if (!runtimeId || usageBuildHash === 'unknown') {
        return { status: 'unknown', reason: 'runtimeUnknown' }
      }
      if (
        record.lease.claimStatus !== 'live' ||
        record.lease.unreconciled ||
        record.lease.handoffStage ||
        !owner ||
        owner.runtime !== runtimeId
      ) {
        return { status: 'unknown', reason: 'notHeld' }
      }
      const before = custody(record)
      const read = await adapter
        .readUsageMeter({ sessionId, fence: record.lease.runtimeFence })
        .catch(() => null)
      const after = host.deps.store.getRecord(sessionId)
      if (
        getStructuredAgentSessionHost() !== host ||
        !after ||
        custody(after) !== before ||
        ctx.runtime.getRuntimeId() !== runtimeId ||
        !read?.isCurrent() ||
        read.meter.sessionId !== sessionId ||
        read.meter.runtimeFence !== record.lease.runtimeFence
      ) {
        return { status: 'unknown', reason: 'unavailableOrChanged' }
      }
      return {
        status: 'ok',
        runtime: { runtimeId, pid: process.pid, buildHash: usageBuildHash },
        meter: read.meter
      }
    }
  })
]
