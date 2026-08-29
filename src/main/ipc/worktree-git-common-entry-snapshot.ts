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
  // Structural leaves change in place every tick; only index uses the entry-dir gate.
  const structuralSignatures = new Map<string, string>()
  const [nextDirSignature, headLogSignature] = await Promise.all([
    gitCommonDirectorySignature(entryPath),
    gitCommonFileSignature(join(entryPath, HEAD_LOG_FILE)),
    Promise.all(
      STRUCTURAL_METADATA_FILES.map(async (name) => {
        const signature = await gitCommonFileSignature(join(entryPath, name))
        if (signature !== null) {
          structuralSignatures.set(name, signature)
        }
      })
    )
  ])
  if (nextDirSignature === 'missing') {
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
    ? await gitCommonFileSignature(join(entryPath, INDEX_FILE))
    : previous.indexSignature
  return {
    dirSignature: nextDirSignature,
    structuralSignatures,
    indexSignature,
    headLogSignature
  }
}
