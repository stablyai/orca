import { pruneAgentSessionOperationRows } from '../../shared/agent-session-operation-ledger'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionStoreState } from './agent-session-record-store-file'
import { agentSessionReconciliationTargetMatches } from './agent-session-reconciliation-target'
import { applyAgentSessionRestartAdjudication } from './agent-session-restart-lease-transitions'

export type AgentSessionRestartProbeArgs = {
  probe: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
  probeMany?: (
    records: readonly AgentSessionRecord[]
  ) => Promise<Map<string, AgentSessionOwnerProbe>>
  now: number
}

type RestartProbe = { record: AgentSessionRecord; probe: AgentSessionOwnerProbe }

export async function collectAgentSessionRestartProbes(
  records: readonly AgentSessionRecord[],
  args: AgentSessionRestartProbeArgs
): Promise<Map<string, RestartProbe>> {
  const probes = new Map<string, RestartProbe>()
  const batched = args.probeMany ? await args.probeMany(records) : null
  for (const record of records) {
    probes.set(record.sessionId, {
      record,
      probe:
        batched?.get(record.sessionId) ??
        (batched
          ? { outcome: 'indeterminate', reason: 'owner batch probe returned no result' }
          : await args.probe(record))
    })
  }
  return probes
}

export function applyAgentSessionRestartProbes(
  state: AgentSessionStoreState,
  probes: ReadonlyMap<string, RestartProbe>,
  now: number
): Map<string, AgentSessionRecord> {
  const reconciled = new Map<string, AgentSessionRecord>()
  for (const [sessionId, probed] of probes) {
    const record = state.records.get(sessionId)
    if (
      !record?.lease.unreconciled ||
      !agentSessionReconciliationTargetMatches(record, probed.record)
    ) {
      continue
    }
    const next = applyAgentSessionRestartAdjudication({ record, probe: probed.probe, now })
    state.records.set(sessionId, next)
    reconciled.set(sessionId, next)
  }
  state.operations = pruneAgentSessionOperationRows(state.operations, now)
  return reconciled
}
