// Which finished workers a linked-worker read may keep: a lineage that a fingerprint of its newest
// Dispatch can stand for. Anything else (a terminal handed to another Dispatch, a long chain) reads live.
import type { WorkerLineage } from '../runtime/orchestration/db/dispatch-context/worker-follow-up-lineage'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { parseWorkerTerminalPriorOwnerIds } from '../runtime/orchestration/db/pane-key-match'
import type { BotWorkWorker } from './bot-work-types'
import type { LinkedWorkerState } from './bot-items-linked-worker-states'

const FINISHED_STATES = new Set<BotWorkWorker['state']>(['completed', 'failed', 'stopped'])
/** Follow-ups a kept read may span; a longer chain reads live. */
const CHAIN_MAX = 32

/** A finished worker waiting to be kept: ids and its projected read only, never the rows it came from. */
export type Finished = {
  ref: string
  worker: BotWorkWorker
  /** Undefined: past the report budget. */
  report: LinkedWorkerState['report'] | undefined
  reason: string | null
  latestId: string
  /** Its resource and every Dispatch that ever owned it; null with none. */
  resource: { id: string; owners: readonly string[] } | null
}

/** A worker that may be kept: local, finished, its newest Dispatch settled and its terminal released. */
export function finishedOf(
  ref: string,
  worker: BotWorkWorker,
  report: LinkedWorkerState['report'] | undefined,
  reason: string | null,
  lineage: WorkerLineage | undefined
): Finished | null {
  const resource = lineage?.resource
  if (
    !lineage ||
    worker.host !== 'local' ||
    lineage.latest.status === 'pending' ||
    lineage.latest.status === 'dispatched' ||
    !FINISHED_STATES.has(worker.state) ||
    // A worker still on a pane reads as the fleet sees every Dispatch on it, so it stays live.
    (resource && resource.ownership_state !== 'released')
  ) {
    return null
  }
  // A plain chain's terminal had at most CHAIN_MAX owners; a longer history reads live, unparsed.
  if (resource && holdsMoreThan(resource.prior_owner_dispatch_ids, CHAIN_MAX)) {
    return null
  }
  const prior = resource ? parseWorkerTerminalPriorOwnerIds(resource.prior_owner_dispatch_ids) : []
  if (prior === null) {
    return null
  }
  return {
    ref,
    worker,
    report,
    reason,
    latestId: lineage.latest.id,
    resource: resource
      ? {
          id: resource.id,
          owners: [resource.origin_dispatch_id, resource.owner_dispatch_id, ...prior]
        }
      : null
  }
}

/** The Dispatches from `ref` to its newest by follow-ups alone, its terminal never owned outside them;
 *  null otherwise. A Dispatch has at most one follow-up, so only the newest can gain one, which the
 *  fingerprint checks; a lineage that took another path would need the whole walk mirrored. */
export function plainChain(db: OrchestrationDb, finished: Finished): string[] | null {
  const chain = [finished.latestId]
  for (let id = finished.latestId; id !== finished.ref;) {
    let parent: string | null | undefined
    try {
      parent = db.getDispatchContextById(id)?.follow_up_of_dispatch_id
    } catch {
      // Unreadable: it reads live, and keeping goes on for the rest.
      return null
    }
    if (!parent || chain.length >= CHAIN_MAX) {
      return null
    }
    chain.push(parent)
    id = parent
  }
  const members = new Set(chain)
  return finished.resource?.owners.some((owner) => !members.has(owner)) ? null : chain
}

/** Whether a JSON array of strings has more than `max` entries, scanning only as far as entry max + 1. */
function holdsMoreThan(json: string, max: number): boolean {
  let entries = 0
  let inString = false
  for (let i = 0; i < json.length; i++) {
    const c = json[i]
    if (inString) {
      if (c === '\\') {
        i++
      } else if (c === '"') {
        inString = false
      }
    } else if (c === '"') {
      inString = true
      entries += 1
      if (entries > max) {
        return true
      }
    }
  }
  return false
}

/** The first `count` values, read straight off the iterator: a long queue is never copied whole. */
export function firstOf<T>(values: Iterable<T>, count: number): T[] {
  const first: T[] = []
  for (const value of values) {
    if (first.length >= count) {
      break
    }
    first.push(value)
  }
  return first
}

export function reportLength(report: LinkedWorkerState['report'] | undefined): number {
  return report ? report.subject.length + (report.body?.length ?? 0) : 0
}

/** A Task's result: a worker's `{ subject, body }` report, or plain text. */
export function taskReport(result: string | null): LinkedWorkerState['report'] {
  if (!result?.trim()) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(result)
    if (parsed && typeof parsed === 'object' && 'subject' in parsed) {
      const body = 'body' in parsed && typeof parsed.body === 'string' ? parsed.body : null
      return { subject: String(parsed.subject ?? ''), body }
    }
  } catch {
    // Plain text is its own report.
  }
  return { subject: result.trim(), body: null }
}
