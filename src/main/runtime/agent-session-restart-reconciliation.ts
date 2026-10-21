import { pruneAgentSessionOperationRows } from '../../shared/agent-session-operation-ledger'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionStoreState } from './agent-session-store-state'
import { agentSessionReconciliationTargetMatches } from './agent-session-reconciliation-target'
import { applyAgentSessionRestartAdjudication } from './agent-session-restart-lease-transitions'

export type AgentSessionRestartProbeArgs = {
  sessionId?: string
  probe: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
  probeMany?: (
    records: readonly AgentSessionRecord[]
  ) => Promise<Map<string, AgentSessionOwnerProbe>>
  now: number
}

type RestartProbe = { record: AgentSessionRecord; probe: AgentSessionOwnerProbe }

export async function collectAgentSessionRestartProbes(
  store: {
    listRecords: () => AgentSessionRecord[]
    getRecord: (sessionId: string) => AgentSessionRecord | null
  },
  args: AgentSessionRestartProbeArgs
): Promise<Map<string, RestartProbe>> {
  const probes = new Map<string, RestartProbe>()
  const target = args.sessionId === undefined ? null : store.getRecord(args.sessionId)
  const candidates = args.sessionId === undefined ? store.listRecords() : target ? [target] : []
  const records = candidates.filter((record) => record.lease.unreconciled)
  if (records.length === 0) {
    return probes
  }
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
