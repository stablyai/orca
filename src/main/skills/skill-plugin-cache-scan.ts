import type { Dirent } from 'node:fs'
import { opendir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'

const MAXIMUM_PLUGIN_SCAN_DEPTH = 9
const MAXIMUM_PLUGIN_SCAN_ENTRIES = 4_096
export const MAXIMUM_PLUGIN_SKILL_CANDIDATES = 64
const MAXIMUM_PLUGIN_INCOMPLETE_PATHS = 16

export type KnownPluginSkillCandidate = {
  name: string
  path: string
}

export type KnownPluginSkillScan = {
  candidates: KnownPluginSkillCandidate[]
  incompletePaths: string[]
}

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null
}

export async function scanKnownPluginSkillCandidates(
  rootPath: string,
  knownNames: ReadonlySet<string>,
  maximumCandidates = MAXIMUM_PLUGIN_SKILL_CANDIDATES
): Promise<KnownPluginSkillScan> {
  const candidates: KnownPluginSkillCandidate[] = []
  const incompletePaths = new Set<string>()
  const visited = new Set<string>()
  let entryCount = 0
  let limitReached = false

  function recordIncomplete(path: string): void {
    if (incompletePaths.has(path)) {
      return
    }
    if (incompletePaths.size >= MAXIMUM_PLUGIN_INCOMPLETE_PATHS) {
      // Why: each incomplete path expands to one conservative row per official
      // skill. Collapse a hostile cache into one poison sentinel before IPC/render fanout.
      incompletePaths.clear()
      incompletePaths.add(rootPath)
      limitReached = true
      return
    }
    incompletePaths.add(path)
  }

  async function visit(directory: string, depth: number): Promise<void> {
    if (limitReached) {
      return
    }
    if (depth > MAXIMUM_PLUGIN_SCAN_DEPTH) {
      recordIncomplete(directory)
      return
    }
    let resolved: string
    try {
      resolved = await realpath(directory)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        recordIncomplete(directory)
      }
      return
    }
    if (visited.has(resolved)) {
      return
    }
    visited.add(resolved)

    let handle: Awaited<ReturnType<typeof opendir>>
    try {
      handle = await opendir(directory)
    } catch {
      recordIncomplete(directory)
      return
    }
    const entries: Dirent[] = []
    try {
      for (;;) {
        const entry = await handle.read()
        if (!entry) {
          break
        }
        entryCount += 1
        if (entryCount > MAXIMUM_PLUGIN_SCAN_ENTRIES) {
          limitReached = true
          recordIncomplete(rootPath)
          break
        }
        entries.push(entry)
      }
    } catch {
      recordIncomplete(directory)
    } finally {
      await handle.close().catch(() => undefined)
    }

    entries.sort((left, right) => (left.name === right.name ? 0 : left.name < right.name ? -1 : 1))
    for (const entry of entries) {
      if (limitReached) {
        return
      }
      const entryPath = join(directory, entry.name)
      let directoryEntry = entry.isDirectory()
      if (entry.isSymbolicLink()) {
        try {
          directoryEntry = (await stat(entryPath)).isDirectory()
        } catch {
          if (knownNames.has(entry.name)) {
            if (candidates.length >= maximumCandidates) {
              limitReached = true
              recordIncomplete(rootPath)
              return
            }
            candidates.push({ name: entry.name, path: entryPath })
          }
          continue
        }
      }
      if (!directoryEntry) {
        continue
      }
      if (knownNames.has(entry.name)) {
        if (candidates.length >= maximumCandidates) {
          limitReached = true
          recordIncomplete(rootPath)
          return
        }
        candidates.push({ name: entry.name, path: entryPath })
        continue
      }
      await visit(entryPath, depth + 1)
    }
  }

  await visit(rootPath, 0)
  return { candidates, incompletePaths: [...incompletePaths] }
}
