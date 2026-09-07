import { stat } from 'node:fs/promises'
import { join } from 'node:path'

const STRUCTURAL_METADATA_FILES = ['HEAD', 'gitdir', 'locked', 'config.worktree']
const INDEX_FILE = 'index'
const HEAD_LOG_FILE = join('logs', 'HEAD')

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

export async function snapshotGitCommonEntry(
  entryPath: string,
  previous: GitCommonEntrySnapshot | undefined,
  forceFullScan: boolean
): Promise<GitCommonEntrySnapshot> {
  // Git writes HEAD/index/config.worktree/locked via a lock file + rename inside the
  // entry dir, so the entry dir's own signature moves on every one of those writes
  // (verified against git 2.55: checkout, commit, amend, reset, ref updates, stash,
  // worktree lock/unlock, config --worktree, index writes all move it). The one
  // in-place exception is `gitdir` (worktree move/repair), which the periodic
  // forceFullScan backstop (INDEX_BACKSTOP_TICKS) below re-stats regardless of this
  // gate. Gating all of these leaves on the entry-dir signature turns an unchanged
  // entry into a single stat per tick instead of stat-ing every leaf every tick.
  const nextDirSignature = await gitCommonDirectorySignature(entryPath)
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
  const shouldRescan = forceFullScan || !previous || previous.dirSignature !== nextDirSignature
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
  return {
    dirSignature: nextDirSignature,
    structuralSignatures,
    indexSignature,
    headLogSignature
  }
}
