import { readFile, realpath, rm } from 'node:fs/promises'
import { relativePathInsideRoot } from '../../../../../../shared/cross-platform-path'

const MAX_REMEMBERED_SESSIONS = 200
const sessionDirectories = new Map<string, string>()

async function realDirectoryPair(
  root: string,
  directory: string
): Promise<{ root: string; directory: string } | null> {
  const [realRoot, realDirectory] = await Promise.all([
    realpath(root).catch(() => null),
    realpath(directory).catch(() => null)
  ])
  return realRoot && realDirectory ? { root: realRoot, directory: realDirectory } : null
}

export async function shellStartDirectory(sessionId: string, root: string): Promise<string> {
  const saved = sessionDirectories.get(sessionId)
  if (saved === undefined) {
    return root
  }
  const real = await realDirectoryPair(root, saved)
  if (real && relativePathInsideRoot(real.root, real.directory) !== null) {
    return saved
  }
  sessionDirectories.delete(sessionId)
  return root
}

export async function rememberShellDirectory(
  sessionId: string,
  root: string,
  file: string
): Promise<void> {
  const next = (await readFile(file, 'utf8').catch(() => '')).trim()
  await rm(file, { force: true }).catch(() => {})
  if (!next) {
    return
  }
  const real = await realDirectoryPair(root, next)
  sessionDirectories.delete(sessionId)
  if (real && relativePathInsideRoot(real.root, real.directory)) {
    sessionDirectories.set(sessionId, real.directory)
    const oldest = sessionDirectories.keys().next().value
    if (sessionDirectories.size > MAX_REMEMBERED_SESSIONS && oldest !== undefined) {
      sessionDirectories.delete(oldest)
    }
  }
}

export async function shellDirectoryLabel(root: string, directory: string): Promise<string | null> {
  const real = await realDirectoryPair(root, directory)
  return real ? relativePathInsideRoot(real.root, real.directory) || null : null
}
