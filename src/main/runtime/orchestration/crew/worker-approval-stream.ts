import type { CrewInvalidation } from './crew-changes'
import type {
  OrchestrationCrewRow,
  OrchestrationWorkerApprovalEntry,
  OrchestrationWorkerApprovalsFrame
} from '../../../../shared/orchestration/orchestration-crew'

export type WorkerApprovalStreamSources = {
  /** The mailboxes the party's workers report to; re-read only when topology changes. */
  mailboxes: () => string[]
  /** The approval rows in those mailboxes, compared to tell whether anything changed. */
  approvals: (mailboxes: string[]) => unknown[]
  /** The party's workers, each with its approvals; read only once the approval rows changed. */
  workers: () => readonly OrchestrationCrewRow[]
  watch: (wake: (facets: CrewInvalidation) => void) => () => void
}

/** A chat's worker approvals: woken by its own mail and Run changes, never by agent status, so an
 *  agent's turn costs a chat nothing; the crew is read only when the approvals themselves change. */
export function subscribeWorkerApprovals(
  sources: WorkerApprovalStreamSources,
  emit: (frame: OrchestrationWorkerApprovalsFrame) => void
): () => void {
  let alive = true
  let queued = false
  let mailboxes: Set<string> | undefined
  // Mail arrived for the party since the last read; a first read has everything to read.
  let mailed = true
  let previous: string | undefined
  let readMailboxes: string | undefined
  const publish = () => {
    if (!alive) {
      return
    }
    let entries: OrchestrationWorkerApprovalEntry[]
    try {
      mailboxes ??= new Set(sources.mailboxes())
      const key = [...mailboxes].join('\n')
      // A Run or Dispatch change matters only to listed approvals or to the mailboxes it moves;
      // new approvals arrive as mail.
      if (!mailed && key === readMailboxes && previous === '[]') {
        return
      }
      mailed = false
      readMailboxes = key
      const rows = mailboxes.size ? sources.approvals([...mailboxes]) : []
      const serialized = JSON.stringify(rows)
      if (serialized === previous) {
        return
      }
      previous = serialized
      entries = rows.length ? approvalEntries(sources.workers()) : []
    } catch {
      // Read again on the next change rather than show a partial list.
      mailboxes = undefined
      mailed = true
      previous = undefined
      readMailboxes = undefined
      return
    }
    emit({ type: 'begin' })
    for (const entry of entries) {
      emit({ type: 'approval', entry })
    }
    emit({ type: 'complete' })
  }
  const unwatch = sources.watch((facets) => {
    const addressed = facets.has('traffic') ? facets.trafficAddresses : undefined
    if (addressed) {
      if (mailboxes && ![...addressed].some((address) => mailboxes!.has(address))) {
        return
      }
      mailed = true
    } else if (facets.has('topology') || facets.has('traffic')) {
      // Runs, Dispatches or routing moved: Orca's approval reports are only ever inserted, addressed.
      mailboxes = undefined
    } else {
      return
    }
    if (queued) {
      return
    }
    queued = true
    queueMicrotask(() => {
      queued = false
      publish()
    })
  })
  publish()
  return () => {
    alive = false
    unwatch()
  }
}

function approvalEntries(
  workers: readonly OrchestrationCrewRow[]
): OrchestrationWorkerApprovalEntry[] {
  return workers
    .flatMap(({ approvals, ...worker }) => (approvals ?? []).map((entry) => ({ ...entry, worker })))
    .sort((a, b) => (a.askedAt ?? a.at).localeCompare(b.askedAt ?? b.at))
}
