import { join } from 'node:path'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import {
  createDegradedBaselineGate,
  startAdaptiveGitCommonPoller,
  tryTakeGitCommonPollBaseline,
  type GitCommonPollingCadence
} from './worktree-git-common-poll-cadence'
import {
  LINKED_WORKTREE_HEAD_LOG_FILE,
  LINKED_WORKTREE_INDEX_FILE,
  PRIMARY_CHECKOUT_METADATA_FILES,
  snapshotGitCommon,
  type GitCommonSnapshot
} from './worktree-git-common-snapshot'

function classifySignatureDiff(
  prevSignature: string | null | undefined,
  nextSignature: string | null | undefined
): 'create' | 'update' | 'delete' | null {
  if (prevSignature == null && nextSignature == null) {
    return null
  }
  if (prevSignature == null) {
    return 'create'
  }
  if (nextSignature == null) {
    return 'delete'
  }
  return prevSignature === nextSignature ? null : 'update'
}

function diffSignatureMaps(
  prev: Map<string, string>,
  next: Map<string, string>,
  resolvePath: (name: string) => string
): WorktreeBasePollEvent[] {
  const events: WorktreeBasePollEvent[] = []
  const names = new Set([...prev.keys(), ...next.keys()])
  for (const name of names) {
    const type = classifySignatureDiff(prev.get(name), next.get(name))
    if (type) {
      events.push({ type, path: resolvePath(name) })
    }
  }
  return events
}

function diffGitCommon(
  commonDirPath: string,
  prev: GitCommonSnapshot,
  next: GitCommonSnapshot
): WorktreeBasePollEvent[] {
  const events: WorktreeBasePollEvent[] = []
  const worktreesDir = join(commonDirPath, 'worktrees')
  const worktreesDirDiff = classifySignatureDiff(
    prev.worktreesDirSignature,
    next.worktreesDirSignature
  )
  if (worktreesDirDiff) {
    events.push({ type: worktreesDirDiff, path: worktreesDir })
  }
  for (const [entryPath, entry] of next.entries) {
    const prevEntry = prev.entries.get(entryPath)
    if (!prevEntry) {
      events.push({ type: 'create', path: entryPath })
      continue
    }
    events.push(
      ...diffSignatureMaps(prevEntry.structuralSignatures, entry.structuralSignatures, (name) =>
        join(entryPath, name)
      )
    )
    const indexDiff = classifySignatureDiff(prevEntry.indexSignature, entry.indexSignature)
    if (indexDiff) {
      events.push({ type: indexDiff, path: join(entryPath, LINKED_WORKTREE_INDEX_FILE) })
    }
    const headLogDiff = classifySignatureDiff(prevEntry.headLogSignature, entry.headLogSignature)
    if (headLogDiff) {
      events.push({ type: headLogDiff, path: join(entryPath, LINKED_WORKTREE_HEAD_LOG_FILE) })
    }
  }
  for (const entryPath of prev.entries.keys()) {
    if (!next.entries.has(entryPath)) {
      events.push({ type: 'delete', path: entryPath })
    }
  }
  events.push(
    ...diffSignatureMaps(prev.primarySignatures, next.primarySignatures, (name) =>
      join(commonDirPath, name)
    )
  )
  return events
}

export async function startGitCommonPolling(
  commonDirPath: string,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  cadence: GitCommonPollingCadence,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void,
  includePrimary = true
): Promise<WorktreeBaseSubscription> {
  let disposed = false
  // Why: with no previous view to retain, a degraded scan *omits* whatever leaf failed rather than
  // holding it. Committing that as the baseline makes the next clean tick diff the missing entry as
  // a create, fanning out a redundant worktree re-list; wait out a bounded number of whole scans.
  const deferDegradedBaseline = createDegradedBaselineGate()
  const baseline = await tryTakeGitCommonPollBaseline(
    () => snapshotGitCommon(commonDirPath, undefined, includePrimary),
    commonDirPath
  )
  let snapshot = baseline && !deferDegradedBaseline(baseline.degraded) ? baseline : null
  const polling = startAdaptiveGitCommonPoller({
    cadence,
    visibility,
    poll: async (forceFullScan) => {
      const next = await snapshotGitCommon(
        commonDirPath,
        snapshot ?? undefined,
        includePrimary,
        forceFullScan
      )
      if (disposed) {
        return { changed: false }
      }
      if (!snapshot) {
        if (deferDegradedBaseline(next.degraded)) {
          // Same reasoning as the baseline above: an incomplete recovery scan would seed holes the
          // next clean tick reports as creates.
          return { changed: false, degraded: true }
        }
        snapshot = next
        onEvents([
          { type: 'update', path: join(commonDirPath, 'worktrees') },
          ...(includePrimary
            ? PRIMARY_CHECKOUT_METADATA_FILES.map((name) => ({
                type: 'update' as const,
                path: join(commonDirPath, name)
              }))
            : [])
        ])
        return { changed: true }
      }
      if (next.didFullScan) {
        onFullScan?.()
      }
      const events = diffGitCommon(commonDirPath, snapshot, next)
      snapshot = next
      if (events.length > 0) {
        onEvents(events)
      }
      return { changed: events.length > 0, degraded: next.degraded }
    }
  })

  return {
    unsubscribe: async () => {
      disposed = true
      await polling.unsubscribe()
    }
  }
}
