import type { Dirent } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isSkillStagingEntryName } from './skill-delete/staging-names'

export const SKILL_FILE_NAME = 'SKILL.md'

function isWithinDepth(rootPath: string, childPath: string, maxDepth: number): boolean {
  const rel = relative(rootPath, childPath)
  if (!rel) {
    return true
  }
  // Why: `..cache` is a valid child name; only a real parent traversal escapes.
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return false
  }
  return rel.split(sep).length <= maxDepth
}

async function readEntries(dirPath: string): Promise<Dirent[] | null> {
  try {
    return await readdir(dirPath, { withFileTypes: true })
  } catch {
    return null
  }
}

/** Abort prevents future filesystem work; dispatched readdir/realpath/stat calls cannot be cancelled and finish in libuv. */
export async function findSkillFiles(
  rootPath: string,
  maxDepth: number,
  signal?: AbortSignal
): Promise<string[]> {
  const out: string[] = []
  const visitedDirectoryPaths = new Set<string>()
  async function visit(dirPath: string): Promise<void> {
    // Reject on abort; a cached truncated listing would falsely report skills removed.
    signal?.throwIfAborted()
    let resolvedDirPath: string
    try {
      resolvedDirPath = await realpath(dirPath)
    } catch {
      return
    }
    if (visitedDirectoryPaths.has(resolvedDirPath)) {
      return
    }
    visitedDirectoryPaths.add(resolvedDirPath)

    const entries = await readEntries(dirPath)
    if (!entries) {
      return
    }
    // Directory entry names add one segment, so siblings share the depth verdict.
    let childrenWithinDepth: boolean | undefined
    for (const entry of entries) {
      signal?.throwIfAborted()
      // Hide transaction siblings so in-flight skills cannot appear twice or be deleted again.
      if (isSkillStagingEntryName(entry.name)) {
        continue
      }
      const entryPath = join(dirPath, entry.name)
      if (entry.name === SKILL_FILE_NAME) {
        if (entry.isFile()) {
          out.push(entryPath)
          continue
        }
        if (entry.isSymbolicLink()) {
          try {
            if ((await stat(entryPath)).isFile()) {
              out.push(entryPath)
            }
          } catch {
            // Broken links are not valid skill files.
          }
        }
        continue
      }
      if (entry.isDirectory()) {
        if ((childrenWithinDepth ??= isWithinDepth(rootPath, entryPath, maxDepth))) {
          await visit(entryPath)
        }
        continue
      }
      if (
        entry.isSymbolicLink() &&
        (childrenWithinDepth ??= isWithinDepth(rootPath, entryPath, maxDepth))
      ) {
        // Follow provider directory links but guard realpaths against cycles.
        let linksToDirectory = false
        try {
          linksToDirectory = (await stat(entryPath)).isDirectory()
        } catch {
          // Broken links are not valid skill directories.
        }
        // Keep recursive visit outside broken-link catch so nested aborts cannot become successful truncated scans.
        if (linksToDirectory) {
          await visit(entryPath)
        }
      }
    }
  }
  await visit(rootPath)
  return out
}
