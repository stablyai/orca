import { stat } from 'node:fs/promises'
import { join } from 'node:path'

const STRUCTURAL_METADATA_FILES = ['HEAD', 'gitdir', 'locked', 'config.worktree']
const INDEX_FILE = 'index'
const HEAD_LOG_FILE = join('logs', 'HEAD')
const GITDIR_FILE = 'gitdir'

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
    gitCommonFileSignature(join(entryPath, GITDIR_FILE)),
    gitCommonFileSignature(join(entryPath, HEAD_LOG_FILE))
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
