import type { Dirent } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isSkillStagingEntryName } from '../filesystem/skill-transaction-staging-names'
import { createDirectoryReadAhead, type WalkOrder } from './skill-directory-read-ahead'

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

/** Codex's own walk skips hidden folders; stopping at a skill folder skips its references and scripts. */
export type SkillFileWalkOptions = {
  skipHiddenDirectories?: boolean
  stopAtSkillDirectories?: boolean
}

function entersDirectory(name: string, options: SkillFileWalkOptions): boolean {
  return (
    name !== SKILL_FILE_NAME &&
    !isSkillStagingEntryName(name) &&
    !(options.skipHiddenDirectories && name.startsWith('.'))
  )
}

function holdsSkillFile(entries: readonly Dirent[]): boolean {
  return entries.some((entry) => entry.name === SKILL_FILE_NAME && !entry.isDirectory())
}

/** Entry indexes of the plain child directories a walk enters. */
function enteredChildIndexes(
  rootPath: string,
  maxDepth: number,
  dirPath: string,
  entries: readonly Dirent[],
  options: SkillFileWalkOptions
): number[] {
  if (options.stopAtSkillDirectories && holdsSkillFile(entries)) {
    return []
  }
  const indexes: number[] = []
  for (const [index, entry] of entries.entries()) {
    if (!entry.isDirectory() || !entersDirectory(entry.name, options)) {
      continue
    }
    // Directory entry names add one segment, so siblings share the depth verdict.
    if (!isWithinDepth(rootPath, join(dirPath, entry.name), maxDepth)) {
      return []
    }
    indexes.push(index)
  }
  return indexes
}

/** Abort prevents future filesystem work; dispatched readdir/realpath/stat calls cannot be cancelled and finish in libuv. */
export async function findSkillFiles(
  rootPath: string,
  maxDepth: number,
  signal?: AbortSignal,
  options: SkillFileWalkOptions = {}
): Promise<string[]> {
  return findRootFiles(rootPath, maxDepth, (name) => name === SKILL_FILE_NAME, signal)
}

/** The same bounded, symlink-guarded walk with a caller-chosen file predicate,
 *  so slash-command roots do not need a second walker. */
export async function findRootFiles(
  rootPath: string,
  maxDepth: number,
  isMatch: (fileName: string) => boolean,
  signal?: AbortSignal
): Promise<string[]> {
  const out: string[] = []
  const visitedDirectoryPaths = new Set<string>()
  const readAhead = createDirectoryReadAhead({
    signal,
    enteredChildIndexes: (dirPath, entries) =>
      enteredChildIndexes(rootPath, maxDepth, dirPath, entries, options)
  })
  async function visit(dirPath: string, order: WalkOrder): Promise<void> {
    // Reject on abort; a cached truncated listing would falsely report skills removed.
    signal?.throwIfAborted()
    const { resolvedPath: resolvedDirPath, entries } = await readAhead.claim(dirPath, order)
    if (resolvedDirPath === null || visitedDirectoryPaths.has(resolvedDirPath)) {
      readAhead.drop(dirPath)
      return
    }
    visitedDirectoryPaths.add(resolvedDirPath)
    if (!entries) {
      return
    }
    const childIndexes = new Set(enteredChildIndexes(rootPath, maxDepth, dirPath, entries, options))
    const leaf = options.stopAtSkillDirectories === true && holdsSkillFile(entries)
    for (const [index, entry] of entries.entries()) {
      signal?.throwIfAborted()
      // Hide transaction siblings so in-flight skills cannot appear twice or be deleted again.
      if (isSkillStagingEntryName(entry.name)) {
        continue
      }
      const entryPath = join(dirPath, entry.name)
      if (isMatch(entry.name)) {
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
        if (childIndexes.has(index)) {
          await visit(entryPath, [...order, index])
        }
        continue
      }
      if (
        !leaf &&
        entry.isSymbolicLink() &&
        entersDirectory(entry.name, options) &&
        isWithinDepth(rootPath, entryPath, maxDepth)
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
          await visit(entryPath, [...order, index])
        }
      }
    }
  }
  await visit(rootPath, [])
  return out
}
