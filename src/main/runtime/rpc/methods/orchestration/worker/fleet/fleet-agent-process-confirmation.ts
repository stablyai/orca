import {
  createFleetStatusIndex,
  statusForFleetWorker
} from '../../../../../../../shared/orchestration/fleet/orchestration-fleet-status-index'
import { fleetStatusAcceptsProcessConfirmation } from '../../../../../../../shared/orchestration/fleet/orchestration-fleet-worker-projection'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../../../shared/agent-status/contracts/agent-status-freshness'
import type { FleetAgentStatusEvidence } from '../../../../../../../shared/orchestration/fleet/orchestration-fleet-agent-status-evidence'
import type { AgentProcessVerdict } from '../../../../../../../shared/agent-status/process/agent-process-presence'
import {
  projectDurableWorker,
  type WorkerAttentionFacts,
  type WorkerListRow
} from './fleet-durable-worker'

/**
 * Re-probe the recorded process behind stale at-rest/running hook evidence, then mark that
 * evidence current. Probing is limited to rows a worker on this page actually projects, and a
 * failed or absent probe leaves the row stale. Nothing here restamps the hook clock or persists.
 */
export async function confirmStaleWorkerAgentProcesses(args: {
  rows: readonly WorkerListRow[]
  attentionFacts: WorkerAttentionFacts
  statuses: readonly FleetAgentStatusEvidence[]
  now: number
  checkPresence?: (paneKey: string) => Promise<AgentProcessVerdict | null>
}): Promise<readonly FleetAgentStatusEvidence[]> {
  const { checkPresence } = args
  if (!checkPresence) {
    return args.statuses
  }
  const workers = args.rows.map((row) => projectDurableWorker(row, args.attentionFacts))
  const index = createFleetStatusIndex(args.statuses, workers)
  const candidates = new Map<FleetAgentStatusEvidence, string>()
  for (const worker of workers) {
    const evidence = statusForFleetWorker(worker, index)
    if (
      !evidence ||
      // A confirmation that is still current needs no second probe; an expired one is re-earned.
      (evidence.processConfirmedAt !== undefined &&
        args.now - evidence.processConfirmedAt <= AGENT_STATUS_STALE_AFTER_MS) ||
      !fleetStatusAcceptsProcessConfirmation(evidence, args.now)
    ) {
      continue
    }
    candidates.set(evidence, evidence.activity.paneKey)
  }
  if (candidates.size === 0) {
    return args.statuses
  }
  const probes = new Map<string, Promise<AgentProcessVerdict | null>>()
  const confirmed = new Set<FleetAgentStatusEvidence>()
  await Promise.all(
    [...candidates].map(async ([evidence, paneKey]) => {
      let probe = probes.get(paneKey)
      if (!probe) {
        probe = checkPresence(paneKey).catch(() => null)
        probes.set(paneKey, probe)
      }
      if ((await probe) === 'live') {
        confirmed.add(evidence)
      }
    })
  )
  return confirmed.size === 0
    ? args.statuses
    : args.statuses.map((evidence) =>
        confirmed.has(evidence) ? { ...evidence, processConfirmedAt: args.now } : evidence
      )
}
