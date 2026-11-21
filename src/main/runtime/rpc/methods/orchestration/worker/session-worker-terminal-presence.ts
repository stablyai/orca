import type { OrchestrationSessionWorker } from '../../../../../../shared/orchestration-session-workers'
// Whether an open terminal worker's host can find its terminal at all. A display fact, never a recorded exit.
import type {
  FleetDurableWorker,
  OrchestrationFleetWorker
} from '../../../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import { isStructuredWorkerHandle } from '../../../../../../shared/orchestration/workers/structured-worker-handle'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

/** The terminal reads that tell a missing terminal from an unconfirmed one; a reader without them never says missing. */
export type TerminalPresenceReads = Pick<
  OrcaRuntimeService,
  | 'refreshAuthoritativeTerminalInventory'
  | 'getTerminalHandleForPaneKey'
  | 'resolveTerminalHandleByProcessIncarnation'
  | 'resolveTerminalIdentity'
  | 'knowsNonLocalTerminalHost'
>

export type TerminalPresenceCandidate = {
  worker: Pick<OrchestrationFleetWorker, 'liveness' | 'host'>
  durable: Pick<FleetDurableWorker, 'agentTerminalHandle' | 'paneKey' | 'resource'>
}

function readsTerminalPresence(
  runtime: Partial<TerminalPresenceReads>
): runtime is TerminalPresenceReads {
  return (
    typeof runtime.refreshAuthoritativeTerminalInventory === 'function' &&
    typeof runtime.getTerminalHandleForPaneKey === 'function' &&
    typeof runtime.resolveTerminalHandleByProcessIncarnation === 'function' &&
    typeof runtime.resolveTerminalIdentity === 'function' &&
    typeof runtime.knowsNonLocalTerminalHost === 'function'
  )
}

/** Only an open, local terminal worker with no status row can be looked for; anything else stays as its fleet read it. */
function mayBeAbsent({ worker, durable }: TerminalPresenceCandidate): boolean {
  const handle = durable.agentTerminalHandle
  return (
    worker.liveness.verdict === 'unverifiable' &&
    worker.liveness.reason === 'missing_status' &&
    worker.host.kind === 'local' &&
    !!handle &&
    !isStructuredWorkerHandle(handle)
  )
}

/** Against the graph the census settled: no terminal holds its pane (a click looks there first), and its recorded
 *  handle and any handle reminted from its process are each proven stale. A read that can't tell keeps it open. */
function missingFromGraph(
  runtime: TerminalPresenceReads,
  { durable }: TerminalPresenceCandidate
): boolean {
  try {
    if (durable.paneKey && runtime.getTerminalHandleForPaneKey(durable.paneKey)) {
      return false
    }
    const incarnation = durable.resource?.processIncarnation
    const reminted = incarnation
      ? runtime.resolveTerminalHandleByProcessIncarnation(
          incarnation,
          durable.resource?.hostScope ?? null
        )
      : null
    // resolveTerminalIdentity throws when it can't look and answers not-live only for a stale handle.
    return ![durable.agentTerminalHandle, reminted].some(
      (entry) => entry && runtime.resolveTerminalIdentity(entry).live
    )
  } catch {
    return false
  }
}

/**
 * For each worker, whether this host can't find its terminal. One local controller census, at most a second old and
 * shared with other reads, serves the whole read: it is taken only when some worker can be looked for, every worker
 * is then checked against the graph it settled, and a census that can't vouch for this host, or a controller swap or
 * graph reload before the checks end, keeps all of them unconfirmed.
 */
export async function terminalsProvenAbsent(
  runtime: Partial<TerminalPresenceReads>,
  candidates: readonly TerminalPresenceCandidate[]
): Promise<boolean[]> {
  const unconfirmed = candidates.map(() => false)
  if (!readsTerminalPresence(runtime)) {
    return unconfirmed
  }
  // A legacy row with no host scope reads as local, but its terminal may sit on an SSH host the census never asks.
  const unscopedMayBeRemote =
    candidates.some((candidate) => !candidate.durable.resource?.hostScope) &&
    runtime.knowsNonLocalTerminalHost()
  const eligible = candidates.map(
    (candidate) =>
      mayBeAbsent(candidate) && (!!candidate.durable.resource?.hostScope || !unscopedMayBeRemote)
  )
  if (!eligible.includes(true)) {
    return unconfirmed
  }
  let isCensusCurrent: (() => boolean) | null
  try {
    isCensusCurrent = await runtime.refreshAuthoritativeTerminalInventory()
  } catch {
    return unconfirmed
  }
  if (!isCensusCurrent) {
    return unconfirmed
  }
  const absent = candidates.map(
    (candidate, index) => eligible[index] && missingFromGraph(runtime, candidate)
  )
  try {
    return isCensusCurrent() ? absent : unconfirmed
  } catch {
    return unconfirmed
  }
}

export async function projectTerminalPresence(
  runtime: Partial<TerminalPresenceReads>,
  reads: readonly { read: OrchestrationSessionWorker; candidate: TerminalPresenceCandidate }[]
): Promise<OrchestrationSessionWorker[]> {
  const lookFor = reads.filter(
    ({ read }) => read.state === 'unverifiable' && read.chatSessionId === null
  )
  const absent = new Set<OrchestrationSessionWorker>()
  if (lookFor.length > 0) {
    const verdicts = await terminalsProvenAbsent(
      runtime,
      lookFor.map(({ candidate }) => candidate)
    )
    lookFor.forEach(({ read }, index) => verdicts[index] && absent.add(read))
  }
  return reads.map(({ read }) => (absent.has(read) ? { ...read, state: 'stopped' as const } : read))
}
