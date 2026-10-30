import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveOmpSessionsDir } from '../ai-vault/omp-session-root'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'

const YIELD_EVERY_DISCOVERY_ENTRIES = 100

export async function yieldToEventLoop(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setImmediate(resolve)
  await promise
}

async function walkJsonlFiles(
  dirPath: string,
  files: string[],
  progress: { entriesVisited: number }
): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch((error: unknown) => {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  })
  for (const entry of entries) {
    progress.entriesVisited += 1
    if (progress.entriesVisited % YIELD_EVERY_DISCOVERY_ENTRIES === 0) {
      await yieldToEventLoop()
    }
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      await walkJsonlFiles(fullPath, files, progress)
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath)
    }
  }
}

async function listProfileNames(): Promise<string[]> {
  const env = process.env
  const profileDirs = [join(homedir(), env.PI_CONFIG_DIR || '.omp', 'profiles')]
  if (env.XDG_DATA_HOME?.trim()) {
    profileDirs.push(join(env.XDG_DATA_HOME, 'omp', 'profiles'))
  }
  const names = new Set<string>()
  for (const dirPath of profileDirs) {
    const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory()) {
        names.add(entry.name)
      }
    }
  }
  return [...names].sort()
}

/** Session files under every resolvable omp profile root, deduped by path for multi-profile scans. */
export async function listOmpSessionFiles(): Promise<string[]> {
  const roots = new Set<string>()
  const primaryRoot = resolveOmpSessionsDir()
  if (primaryRoot) {
    roots.add(primaryRoot)
  }
  // An explicit sessions root names the whole corpus; profile siblings cannot live there.
  if (!process.env.OMP_CODING_AGENT_DIR?.trim()) {
    for (const profile of await listProfileNames()) {
      const profileRoot = resolveOmpSessionsDir({ env: { ...process.env, OMP_PROFILE: profile } })
      if (profileRoot) {
        roots.add(profileRoot)
      }
    }
  }

  const files: string[] = []
  const progress = { entriesVisited: 0 }
  for (const root of roots) {
    await walkJsonlFiles(root, files, progress)
  }
  return [...new Set(files)].sort()
}
