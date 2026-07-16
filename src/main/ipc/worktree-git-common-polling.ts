import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription
} from './worktree-base-directory-poller'

// Shared with the darwin primary-metadata poll so the platforms cannot drift
// on which shallow leaves count as watchable metadata. `logs/HEAD` catches
// head moves that rewrite no other watched leaf (commit --amend, reset
// --soft); `config.worktree` carries the sparse flag.
export const PRIMARY_CHECKOUT_METADATA_FILES = [
  'HEAD',
  'packed-refs',
  'index',
  'config.worktree',
  'logs/HEAD'
]
const LINKED_WORKTREE_STRUCTURAL_METADATA_FILES = ['HEAD', 'gitdir', 'locked', 'config.worktree']
const LINKED_WORKTREE_INDEX_FILE = 'index'
const LINKED_WORKTREE_HEAD_LOG_FILE = join('logs', 'HEAD')
// Why: the entry-dir signature gate can miss same-granule index rewrites on
// coarse-mtime filesystems; a periodic ungated re-stat bounds that miss the
// same way the base poller's backstop rescan does.
const INDEX_BACKSTOP_TICKS = 15

function statSignature(s: { mtimeMs: number; ctimeMs: number; ino: number; size: number }): string {
  return `${s.mtimeMs}:${s.ctimeMs}:${s.ino}:${s.size}`
}

async function fileSignature(path: string): Promise<string | null> {
  try {
    const s = await stat(path)
    return s.isFile() ? statSignature(s) : null
  } catch {
    return null
  }
}

async function pathSignature(path: string): Promise<string | null> {
  try {
    const s = await stat(path)
    // Why: omitting ctime keeps unrelated metadata churn from re-opening the
    // index gate, which would make the HEAD regression test vacuous. The gate
    // is load-bearing for index-event emission between backstop ticks; the
    // renderer's status poll is the ultimate freshness net.
    return `${s.mtimeMs}:${s.ino}:${s.size}`
  } catch {
    return null
  }
}

type GitCommonEntrySnapshot = {
  dirSignature: string | null
  structuralSignatures: Map<string, string>
  indexSignature: string | null
  headLogSignature: string | null
}

type GitCommonSnapshot = {
  worktreesDirSignature: string | null
  entries: Map<string, GitCommonEntrySnapshot>
  primarySignatures: Map<string, string>
}

async function snapshotGitCommonEntry(
  entryPath: string,
  previous: GitCommonEntrySnapshot | undefined,
  forceIndexRead: boolean
): Promise<GitCommonEntrySnapshot> {
  const dirSignature = await pathSignature(entryPath)
  const structuralSignatures = new Map<string, string>()
  await Promise.all(
    LINKED_WORKTREE_STRUCTURAL_METADATA_FILES.map(async (name) => {
      const signature = await fileSignature(join(entryPath, name))
      if (signature !== null) {
        structuralSignatures.set(name, signature)
      }
    })
  )
  // `logs/HEAD` lives in a subdirectory, so appends never bump the entry-dir
  // mtime — it must be stat'd every tick rather than gated like `index`.
  const headLogSignature = await fileSignature(join(entryPath, LINKED_WORKTREE_HEAD_LOG_FILE))
  const shouldReadIndex = forceIndexRead || !previous || previous.dirSignature !== dirSignature
  const indexSignature = shouldReadIndex
    ? await fileSignature(join(entryPath, LINKED_WORKTREE_INDEX_FILE))
    : previous.indexSignature
  return { dirSignature, structuralSignatures, indexSignature, headLogSignature }
}

async function snapshotPrimaryCheckoutSignatures(
  commonDirPath: string
): Promise<Map<string, string>> {
  const signatures = new Map<string, string>()
  await Promise.all(
    PRIMARY_CHECKOUT_METADATA_FILES.map(async (name) => {
      const signature = await fileSignature(join(commonDirPath, name))
      if (signature !== null) {
        signatures.set(name, signature)
      }
    })
  )
  return signatures
}

async function snapshotGitCommon(
  commonDirPath: string,
  previous?: GitCommonSnapshot,
  includePrimary = true,
  forceIndexRead = false
): Promise<GitCommonSnapshot> {
  const entriesByPath = new Map<string, GitCommonEntrySnapshot>()
  const worktreesDir = join(commonDirPath, 'worktrees')
  const worktreesDirSignature = await pathSignature(worktreesDir)
  const primarySignatures = includePrimary
    ? await snapshotPrimaryCheckoutSignatures(commonDirPath)
    : new Map<string, string>()
  let entries
  try {
    entries = await readdir(worktreesDir, { withFileTypes: true })
  } catch {
    // Missing worktrees dir is normal for repos without linked worktrees.
    return {
      worktreesDirSignature,
      entries: entriesByPath,
      primarySignatures
    }
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) {
        return
      }
      const entryPath = join(worktreesDir, entry.name)
      entriesByPath.set(
        entryPath,
        await snapshotGitCommonEntry(entryPath, previous?.entries.get(entryPath), forceIndexRead)
      )
    })
  )
  return {
    worktreesDirSignature,
    entries: entriesByPath,
    primarySignatures
  }
}

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
  pollIntervalMs: number,
  onFullScan?: () => void,
  includePrimary = true
): Promise<WorktreeBaseSubscription> {
  let disposed = false
  let ticking = false
  let tickCount = 0
  let snapshot = await snapshotGitCommon(commonDirPath, undefined, includePrimary)

  const timer = setInterval(() => {
    if (disposed || ticking) {
      return
    }
    ticking = true
    tickCount++
    const forceIndexRead = tickCount % INDEX_BACKSTOP_TICKS === 0
    onFullScan?.()
    void snapshotGitCommon(commonDirPath, snapshot, includePrimary, forceIndexRead)
      .then((next) => {
        if (disposed) {
          return
        }
        const events = diffGitCommon(commonDirPath, snapshot, next)
        snapshot = next
        if (events.length > 0) {
          onEvents(events)
        }
      })
      .catch(() => {
        // Transient fs error: keep the previous snapshot and retry next tick.
      })
      .finally(() => {
        ticking = false
      })
  }, pollIntervalMs)
  timer.unref?.()

  return {
    unsubscribe: async () => {
      disposed = true
      clearInterval(timer)
    }
  }
}
