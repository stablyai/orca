import type { OrchestrationDb } from '../db/orchestration-db'
import { runLifecycleWriteTransaction } from '../db/lifecycle-write-transaction-runner'
import type { StructuredAgentSessionStatusSink } from '../../../native-chat/agent-session-wire/observations/structured-agent-session-status-ownership'
import type { AgentChildWorkReconcileOutcome } from '../../../../shared/agent-status/child-work/agent-status-child-work-evidence-admission'
import {
  WorkerDockEntry,
  WorkerDockIdentity
} from '../../../../shared/orchestration/dock/worker-dock'
import { workerDockSourceOfSession } from './worker-dock-source'

export function retainProviderFailures(
  db: OrchestrationDb,
  source: string,
  failures: NonNullable<AgentChildWorkReconcileOutcome['failures']>
): void {
  let changed = false
  runLifecycleWriteTransaction(db.db, 'worker_dock_provider_failure', () => {
    const insert = db.db.prepare(`INSERT OR IGNORE INTO worker_dock_provider_failures
        (id, source, settlement, changed_at, entry) VALUES (?, ?, ?, ?, ?)`)
    for (const { child, providerId } of failures) {
      const id = JSON.stringify(['provider', child.childWorkId, child.invocation])
      const at = child.settledAt ?? child.observedAt
      const entry = WorkerDockEntry.parse({
        id,
        dispatchId: id,
        source,
        kind: child.kind,
        name: child.name ?? child.agentType ?? child.kind,
        title: child.description ?? child.name ?? providerId,
        model: child.model ?? null,
        state: 'failed',
        changedAt: at,
        startedAt: child.firstObservedAt,
        reason: child.lastMessage ?? null,
        settlement: id,
        resultId: null,
        stoppable: false
      })
      changed ||= insert.run(id, source, id, at, JSON.stringify(entry)).changes > 0
    }
  })
  // A failure already kept (a replayed batch) changes nothing anyone reads.
  if (changed) {
    db.workerDockSources.providerFailed(source)
    db.crewChanges.notify(new Set(['topology']))
  }
}

export function workerDockFailureSink(
  sink: StructuredAgentSessionStatusSink | null,
  runtime: { getOrchestrationDb: () => OrchestrationDb }
): StructuredAgentSessionStatusSink | undefined {
  if (!sink) {
    return undefined
  }
  return {
    ...sink,
    publishChildWork: (subject, evidence, provider) => {
      const result = sink.publishChildWork?.(subject, evidence, provider)
      if (result?.failures?.length) {
        // Stored under the chat's /clear root, where its dock reads and clears them.
        retainProviderFailures(
          runtime.getOrchestrationDb(),
          workerDockSourceOfSession(subject.sessionId),
          result.failures
        )
      }
      return result
    }
  }
}

export const providerFailureEligibleSql = `f.source = ? AND NOT EXISTS (
  SELECT 1 FROM worker_dock_acknowledgments a WHERE a.source = f.source
    AND a.dispatch_id = f.id AND a.settlement = f.settlement)`

export function readProviderFailureIdentities(db: OrchestrationDb, source: string) {
  if (!db.workerDockSources.hasProviderFailures(source)) {
    return null
  }
  const rows = db.db
    .prepare(`SELECT id, id AS dispatchId, settlement, changed_at AS changedAt,
    json_extract(entry, '$.kind') AS kind, 'failed' AS state, 1 AS ownerActionsAvailable,
    json_extract(entry, '$.model') IS NOT NULL AS hasModel FROM worker_dock_provider_failures f
    WHERE ${providerFailureEligibleSql}`)
    .all(source)
    .map((row) =>
      WorkerDockIdentity.parse({
        ...row,
        ownerActionsAvailable: true,
        hasModel: row.hasModel === 1
      })
    )
  if (!rows.length) {
    db.workerDockSources.rememberNoProviderFailures(source)
  }
  return rows
}

export function readProviderFailureRows(db: OrchestrationDb, ids: string[]): WorkerDockEntry[] {
  return db.db
    .prepare(`SELECT entry FROM json_each(?) selected
    CROSS JOIN worker_dock_provider_failures f ON f.id = selected.value`)
    .all(JSON.stringify(ids))
    .map((row) => WorkerDockEntry.parse(JSON.parse(String(row.entry))))
}
