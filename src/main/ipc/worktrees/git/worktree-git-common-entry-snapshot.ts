import { stat } from 'node:fs/promises'
import { join, sep } from 'node:path'

const HEAD_FILE = 'HEAD'
const GITDIR_FILE = 'gitdir'
const LOCKED_FILE = 'locked'
const CONFIG_WORKTREE_FILE = 'config.worktree'
const INDEX_FILE = 'index'
const HEAD_LOG_FILE = join('logs', 'HEAD')

function joinLeaf(dir: string, leaf: string): string {
  const len = dir.length
  if (len === 0) {
    return leaf
  }
  const last = dir.charCodeAt(len - 1)
  if (last === 0x2f || (sep === '\\' && last === 0x5c)) {
    return `${dir}${leaf}`
  }
  return `${dir}${sep}${leaf}`
}

function statSignature(value: { mtimeMs: number; ctimeMs: number; ino: number }): string {
  return `${value.mtimeMs}:${value.ctimeMs}:${value.ino}`
}

export async function gitCommonDirectorySignature(
  path: string,
  previousSignature = 'missing',
  onMissing?: () => void
): Promise<string> {
  try {
    const value = await stat(path)
    return `${statSignature(value)}:${value.size}`
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      onMissing?.()
      return 'missing'
    }
    return previousSignature
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

// In-place gitdir/reflog writes do not alter entry signatures; slow-cadence callers must stat these leaves.
async function inPlaceLeavesChanged(
  entryPath: string,
  previous: GitCommonEntrySnapshot
): Promise<boolean> {
  const [gitdirSignature, headLogSignature] = await Promise.all([
    gitCommonFileSignature(joinLeaf(entryPath, GITDIR_FILE)),
    gitCommonFileSignature(joinLeaf(entryPath, HEAD_LOG_FILE))
  ])
  return (
    gitdirSignature !== (previous.structuralSignatures.get(GITDIR_FILE) ?? null) ||
    headLogSignature !== previous.headLogSignature
  )
}

// Null can be a transient miss; creation/removal already changes the directory signature.
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
  // Lock-and-rename writes change entry signatures; in-place gitdir/reflog writes need direct probes or ungated backstops.
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
  const [
    headLogSignature,
    indexSignature,
    headSignature,
    gitdirSignature,
    lockedSignature,
    configWorktreeSignature
  ] = await Promise.all([
    gitCommonFileSignature(joinLeaf(entryPath, HEAD_LOG_FILE)),
    gitCommonFileSignature(joinLeaf(entryPath, INDEX_FILE)),
    gitCommonFileSignature(joinLeaf(entryPath, HEAD_FILE)),
    gitCommonFileSignature(joinLeaf(entryPath, GITDIR_FILE)),
    gitCommonFileSignature(joinLeaf(entryPath, LOCKED_FILE)),
    gitCommonFileSignature(joinLeaf(entryPath, CONFIG_WORKTREE_FILE))
  ])
  const structuralSignatures = new Map<string, string>()
  if (headSignature !== null) {
    structuralSignatures.set(HEAD_FILE, headSignature)
  }
  if (gitdirSignature !== null) {
    structuralSignatures.set(GITDIR_FILE, gitdirSignature)
  }
  if (lockedSignature !== null) {
    structuralSignatures.set(LOCKED_FILE, lockedSignature)
  }
  if (configWorktreeSignature !== null) {
    structuralSignatures.set(CONFIG_WORKTREE_FILE, configWorktreeSignature)
  }
  const next = {
    dirSignature: nextDirSignature,
    structuralSignatures,
    indexSignature,
    headLogSignature
  }
  // Recheck the directory so a racing rename does not falsely prove its signature unreliable.
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
