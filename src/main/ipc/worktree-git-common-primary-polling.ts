import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import { PRIMARY_CHECKOUT_METADATA_FILES } from './worktree-git-common-polling'

type PrimaryMetadataSnapshot = {
  signatures: Map<string, string>
  statusRefPaths: Set<string>
}

async function snapshotPrimaryCheckoutMetadata(
  commonDirPath: string,
  getStatusRefPaths: () => readonly string[]
): Promise<PrimaryMetadataSnapshot> {
  const signatures = new Map<string, string>()
  const statusRefPaths = new Set(getStatusRefPaths())
  const paths = [
    ...PRIMARY_CHECKOUT_METADATA_FILES.map((name) => join(commonDirPath, name)),
    ...statusRefPaths
  ]
  await Promise.all(
    paths.map(async (filePath) => {
      try {
        const value = await stat(filePath)
        if (value.isFile()) {
          signatures.set(filePath, `${value.mtimeMs}:${value.ctimeMs}:${value.ino}:${value.size}`)
        }
      } catch {
        // Missing dynamic leaves remain selected so later creation is visible.
      }
    })
  )
  return { signatures, statusRefPaths }
}

function classifyMetadataSignatureDiff(
  prevSignature: string | undefined,
  nextSignature: string | undefined
): WorktreeBasePollEvent['type'] | null {
  if (prevSignature === undefined && nextSignature === undefined) {
    return null
  }
  if (prevSignature === undefined) {
    return 'create'
  }
  if (nextSignature === undefined) {
    return 'delete'
  }
  return prevSignature === nextSignature ? null : 'update'
}

function diffPrimaryMetadata(
  prev: PrimaryMetadataSnapshot,
  next: PrimaryMetadataSnapshot
): WorktreeBasePollEvent[] {
  const events: WorktreeBasePollEvent[] = []
  const paths = new Set([...prev.signatures.keys(), ...next.signatures.keys()])
  for (const path of paths) {
    const isStatusRef = prev.statusRefPaths.has(path) || next.statusRefPaths.has(path)
    if (isStatusRef && (!prev.statusRefPaths.has(path) || !next.statusRefPaths.has(path))) {
      continue
    }
    const type = classifyMetadataSignatureDiff(prev.signatures.get(path), next.signatures.get(path))
    if (type) {
      events.push({ type, path })
    }
  }
  return events
}

export async function startGitCommonPrimaryPolling(
  commonDirPath: string,
  getStatusRefPaths: () => readonly string[],
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void
): Promise<WorktreeBaseSubscription> {
  let disposed = false
  let ticking = false
  let snapshot = await snapshotPrimaryCheckoutMetadata(commonDirPath, getStatusRefPaths)
  let timer: ReturnType<typeof setTimeout> | null = null
  let parkedWhileHidden = false

  const tick = async (): Promise<void> => {
    timer = null
    if (disposed) {
      return
    }
    if (!visibility.isWindowVisible()) {
      parkedWhileHidden = true
      return
    }
    if (ticking) {
      return
    }
    ticking = true
    const startedAt = Date.now()
    onFullScan?.()
    try {
      const next = await snapshotPrimaryCheckoutMetadata(commonDirPath, getStatusRefPaths)
      if (disposed) {
        return
      }
      const events = diffPrimaryMetadata(snapshot, next)
      snapshot = next
      if (events.length > 0) {
        onEvents(events)
      }
    } catch {
      // Transient fs error: keep the previous snapshot and retry next tick.
    } finally {
      ticking = false
    }
    if (!disposed) {
      const nextDelay = Math.max(
        0,
        Math.min(pollIntervalMs, pollIntervalMs - (Date.now() - startedAt))
      )
      timer = setTimeout(() => void tick(), nextDelay)
      timer.unref?.()
    }
  }

  const unsubscribeVisibility = visibility.onWindowBecameVisible(() => {
    if (disposed || !parkedWhileHidden) {
      return
    }
    parkedWhileHidden = false
    void tick()
  })
  timer = setTimeout(() => void tick(), pollIntervalMs)
  timer.unref?.()

  return {
    unsubscribe: async () => {
      disposed = true
      if (timer) {
        clearTimeout(timer)
      }
      unsubscribeVisibility()
    }
  }
}
