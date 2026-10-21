import { stat } from 'node:fs/promises'
import { join } from 'node:path'

const STRUCTURAL_METADATA_FILES = ['HEAD', 'gitdir', 'locked', 'config.worktree']
const INDEX_FILE = 'index'
const HEAD_LOG_FILE = join('logs', 'HEAD')
const GITDIR_FILE = 'gitdir'

function statSignature(value: { mtimeMs: number; ctimeMs: number; ino: number }): string {
  return `${value.mtimeMs}:${value.ctimeMs}:${value.ino}`
}

export async function gitCommonDirectorySignature(path: string): Promise<string> {
  try {
    const value = await stat(path)
    return `${statSignature(value)}:${value.size}`
  } catch {
    return 'missing'
  }
}

export async function gitCommonFileSignature(path: string): Promise<string | null> {
  try {
    const value = await stat(path)
    return value.isFile() ? `${statSignature(value)}:${value.size}` : null
  } catch {
    return null
  }
}

export type GitCommonEntrySnapshot = {
  dirSignature: string
  structuralSignatures: Map<string, string>
  indexSignature: string | null
  headLogSignature: string | null
}

// Why: git rewrites `gitdir` in place and appends `logs/HEAD` in place, so neither
// moves the entry dir's signature; stat them directly when the caller can't rely
// on a short backstop to catch them.
async function inPlaceLeavesChanged(
  entryPath: string,
  previous: GitCommonEntrySnapshot
): Promise<boolean> {
  const [gitdirSignature, headLogSignature] = await Promise.all([
    gitCommonFileSignature(join(entryPath, GITDIR_FILE)),
    gitCommonFileSignature(join(entryPath, HEAD_LOG_FILE))
  ])
  return (
    gitdirSignature !== (previous.structuralSignatures.get(GITDIR_FILE) ?? null) ||
    headLogSignature !== previous.headLogSignature
  )
}

// Only leaf rewrites count: a null side may be a transient stat miss, and
// create/unlink of a leaf (e.g. `locked`) is a real dir change anyway.
function gatedLeafRewritten(
  previous: GitCommonEntrySnapshot,
  next: GitCommonEntrySnapshot
): boolean {
  if (
    previous.indexSignature !== null &&
    next.indexSignature !== null &&
    previous.indexSignature !== next.indexSignature
  ) {
    return true
  }
  for (const [name, signature] of next.structuralSignatures) {
    const previousSignature = previous.structuralSignatures.get(name)
    if (
      name !== GITDIR_FILE &&
      previousSignature !== undefined &&
      previousSignature !== signature
    ) {
      return true
    }
  }
  return false
}

export async function snapshotGitCommonEntry(
  entryPath: string,
  previous: GitCommonEntrySnapshot | undefined,
  forceFullScan: boolean,
  statInPlaceLeaves = false,
  onDirGateMiss?: () => void
): Promise<GitCommonEntrySnapshot> {
  // Git writes HEAD/index/config.worktree/locked via a lock file + rename inside the
  // entry dir, so the entry dir's own signature moves on every one of those writes
  // (verified against git 2.55: checkout, commit, amend, reset, ref updates, stash,
  // worktree lock/unlock, config --worktree, index writes all move it). The one
  // in-place exception is `gitdir` (worktree move/repair), which the periodic
  // forceFullScan backstop (INDEX_BACKSTOP_TICKS) below re-stats regardless of this
  // gate. Gating all of these leaves on the entry-dir signature turns an unchanged
  // entry into a single stat per tick instead of stat-ing every leaf every tick.
  // statInPlaceLeaves adds the two in-place leaves for slow-cadence callers.
  const [nextDirSignature, inPlaceChanged] = await Promise.all([
    gitCommonDirectorySignature(entryPath),
    statInPlaceLeaves && previous && !forceFullScan
      ? inPlaceLeavesChanged(entryPath, previous)
      : false
  ])
  if (nextDirSignature === 'missing') {
    return (
      previous ?? {
        dirSignature: nextDirSignature,
        structuralSignatures: new Map(),
        indexSignature: null,
        headLogSignature: null
      }
    )
  }
  const shouldRescan =
    forceFullScan || inPlaceChanged || !previous || previous.dirSignature !== nextDirSignature
  if (!shouldRescan) {
    return previous
  }
  const structuralSignatures = new Map<string, string>()
  const [headLogSignature, indexSignature] = await Promise.all([
    gitCommonFileSignature(join(entryPath, HEAD_LOG_FILE)),
    gitCommonFileSignature(join(entryPath, INDEX_FILE)),
    Promise.all(
      STRUCTURAL_METADATA_FILES.map(async (name) => {
        const signature = await gitCommonFileSignature(join(entryPath, name))
        if (signature !== null) {
          structuralSignatures.set(name, signature)
        }
      })
    )
  ])
  const next = {
    dirSignature: nextDirSignature,
    structuralSignatures,
    indexSignature,
    headLogSignature
  }
  // Why: re-stat the dir so a rename landing between the dir and leaf stats isn't
  // mistaken for a filesystem whose dir signature ignores child renames.
  if (
    onDirGateMiss &&
    previous &&
    previous.dirSignature === nextDirSignature &&
    gatedLeafRewritten(previous, next) &&
    (await gitCommonDirectorySignature(entryPath)) === nextDirSignature
  ) {
    onDirGateMiss()
  }
  return next
}
