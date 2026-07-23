import { opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import type { WorktreeBasePollEvent } from './worktree-base-directory-poller'
import {
  WorktreePollingScanBudget,
  type WorktreePollingScanLimits
} from './worktree-polling-scan-budget'

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
const GIT_COMMON_ENTRY_STAT_CONCURRENCY = 16

function statSignature(s: { mtimeMs: number; ctimeMs: number; ino: number }): string {
  return `${s.mtimeMs}:${s.ctimeMs}:${s.ino}`
}

async function dirSignature(path: string): Promise<string> {
  try {
    const stats = await stat(path)
    return `${statSignature(stats)}:${stats.size}`
  } catch {
    return 'missing'
  }
}

async function fileSignature(path: string): Promise<string | null> {
  try {
    const stats = await stat(path)
    return stats.isFile() ? `${statSignature(stats)}:${stats.size}` : null
  } catch {
    return null
  }
}

type GitCommonEntrySnapshot = {
  dirSignature: string
  structuralSignatures: Map<string, string>
  indexSignature: string | null
  headLogSignature: string | null
}

export type GitCommonSnapshot = {
  worktreesDirSignature: string
  entries: Map<string, GitCommonEntrySnapshot>
  primarySignatures: Map<string, string>
  didFullScan: boolean
}

async function snapshotGitCommonEntry(
  entryPath: string,
  previous: GitCommonEntrySnapshot | undefined,
  forceFullScan: boolean
): Promise<GitCommonEntrySnapshot> {
  // Why: structural leaves can change without the entry directory changing; only the index uses the gate.
  const structuralSignatures = new Map<string, string>()
  const [nextDirSignature, headLogSignature] = await Promise.all([
    dirSignature(entryPath),
    fileSignature(join(entryPath, LINKED_WORKTREE_HEAD_LOG_FILE)),
    Promise.all(
      LINKED_WORKTREE_STRUCTURAL_METADATA_FILES.map(async (name) => {
        const signature = await fileSignature(join(entryPath, name))
        if (signature !== null) {
          structuralSignatures.set(name, signature)
        }
      })
    )
  ])
  if (nextDirSignature === 'missing') {
    // A transient stat failure must not masquerade as a removal; the parent listing is authoritative.
    return (
      previous ?? {
        dirSignature: nextDirSignature,
        structuralSignatures,
        indexSignature: null,
        headLogSignature
      }
    )
  }
  const shouldReadIndex = forceFullScan || !previous || previous.dirSignature !== nextDirSignature
  const indexSignature = shouldReadIndex
    ? await fileSignature(join(entryPath, LINKED_WORKTREE_INDEX_FILE))
    : previous.indexSignature
  return {
    dirSignature: nextDirSignature,
    structuralSignatures,
    indexSignature,
    headLogSignature
  }
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

export async function snapshotGitCommon(
  commonDirPath: string,
  previous?: GitCommonSnapshot,
  includePrimary = true,
  forceFullScan = false,
  scanLimits: Partial<WorktreePollingScanLimits> = {}
): Promise<GitCommonSnapshot> {
  const worktreesDir = join(commonDirPath, 'worktrees')
  const [worktreesDirSignature, primarySignatures] = await Promise.all([
    dirSignature(worktreesDir),
    includePrimary ? snapshotPrimaryCheckoutSignatures(commonDirPath) : new Map<string, string>()
  ])
  // Why: listing is authoritative for add/remove; directory timestamps can collide on coarse filesystems.
  const budget = new WorktreePollingScanBudget(scanLimits)
  let directory: Awaited<ReturnType<typeof opendir>> | undefined
  let entryPaths: string[] = []
  try {
    directory = await opendir(worktreesDir, { bufferSize: 32 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      entryPaths = previous ? [...previous.entries.keys()] : []
    }
  }
  if (directory) {
    for await (const entry of directory) {
      budget.claimEntry()
      if (!entry.isDirectory()) {
        continue
      }
      const entryPath = join(worktreesDir, entry.name)
      budget.claimRetainedPath(entryPath)
      entryPaths.push(entryPath)
    }
  } else {
    for (const entryPath of entryPaths) {
      budget.claimRetainedPath(entryPath)
    }
  }
  const entrySnapshots = await mapWithConcurrency(
    entryPaths,
    GIT_COMMON_ENTRY_STAT_CONCURRENCY,
    async (entryPath) => ({
      entryPath,
      snapshot: await snapshotGitCommonEntry(
        entryPath,
        previous?.entries.get(entryPath),
        forceFullScan
      )
    })
  )
  const entries = new Map<string, GitCommonEntrySnapshot>()
  for (const { entryPath, snapshot } of entrySnapshots) {
    entries.set(entryPath, snapshot)
  }
  return {
    worktreesDirSignature,
    entries,
    primarySignatures,
    didFullScan: forceFullScan
  }
}

function classifySignatureDiff(
  previous: string | null | undefined,
  next: string | null | undefined
): 'create' | 'update' | 'delete' | null {
  if (previous == null && next == null) {
    return null
  }
  if (previous == null) {
    return 'create'
  }
  if (next == null) {
    return 'delete'
  }
  return previous === next ? null : 'update'
}

function diffSignatureMaps(
  previous: Map<string, string>,
  next: Map<string, string>,
  resolvePath: (name: string) => string
): WorktreeBasePollEvent[] {
  const events: WorktreeBasePollEvent[] = []
  const names = new Set([...previous.keys(), ...next.keys()])
  for (const name of names) {
    const type = classifySignatureDiff(previous.get(name), next.get(name))
    if (type) {
      events.push({ type, path: resolvePath(name) })
    }
  }
  return events
}

export function diffGitCommon(
  commonDirPath: string,
  previous: GitCommonSnapshot,
  next: GitCommonSnapshot
): WorktreeBasePollEvent[] {
  const events: WorktreeBasePollEvent[] = []
  const worktreesDir = join(commonDirPath, 'worktrees')
  const worktreesDirDiff = classifySignatureDiff(
    previous.worktreesDirSignature,
    next.worktreesDirSignature
  )
  if (worktreesDirDiff) {
    events.push({ type: worktreesDirDiff, path: worktreesDir })
  }
  for (const [entryPath, entry] of next.entries) {
    const previousEntry = previous.entries.get(entryPath)
    if (!previousEntry) {
      events.push({ type: 'create', path: entryPath })
      continue
    }
    events.push(
      ...diffSignatureMaps(previousEntry.structuralSignatures, entry.structuralSignatures, (name) =>
        join(entryPath, name)
      )
    )
    const indexDiff = classifySignatureDiff(previousEntry.indexSignature, entry.indexSignature)
    if (indexDiff) {
      events.push({ type: indexDiff, path: join(entryPath, LINKED_WORKTREE_INDEX_FILE) })
    }
    const headLogDiff = classifySignatureDiff(
      previousEntry.headLogSignature,
      entry.headLogSignature
    )
    if (headLogDiff) {
      events.push({ type: headLogDiff, path: join(entryPath, LINKED_WORKTREE_HEAD_LOG_FILE) })
    }
  }
  for (const entryPath of previous.entries.keys()) {
    if (!next.entries.has(entryPath)) {
      events.push({ type: 'delete', path: entryPath })
    }
  }
  events.push(
    ...diffSignatureMaps(previous.primarySignatures, next.primarySignatures, (name) =>
      join(commonDirPath, name)
    )
  )
  return events
}
