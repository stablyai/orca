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

/**
 * `signal` bounds the walk's future work, not its current syscall: `readdir`,
 * `realpath`, and `stat` take no signal, so a call already dispatched to the
 * libuv pool runs to completion. Aborting stops the walk issuing *more* of them,
 * which is what keeps an abandoned scan on a stalled mount from growing.
 */
export async function findSkillFiles(
  rootPath: string,
  maxDepth: number,
  signal?: AbortSignal
): Promise<string[]> {
  const out: string[] = []
  const visitedDirectoryPaths = new Set<string>()
  async function visit(dirPath: string): Promise<void> {
    // Why throw rather than return what we have: a truncated listing is
    // indistinguishable from a genuinely small root, and a caller that cached it
    // would publish "these skills no longer exist".
    signal?.throwIfAborted()
    if (!isWithinDepth(rootPath, dirPath, maxDepth)) {
      return
    }
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
    for (const entry of entries) {
      signal?.throwIfAborted()
      // Why: a staged sibling sits directly in a scanned root, so without this a
      // skill mid-transaction surfaces as a second, separately actionable row.
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
        await visit(entryPath)
        continue
      }
      if (entry.isSymbolicLink()) {
        // Why: users commonly symlink agent skill dirs across providers; follow
        // directory links but guard by realpath so recursive links cannot loop.
        let linksToDirectory = false
        try {
          linksToDirectory = (await stat(entryPath)).isDirectory()
        } catch {
          // Broken links are not valid skill directories.
        }
        // Why outside the catch: it must not swallow the abort a nested visit
        // throws, which would let the walk return a truncated list as success.
        if (linksToDirectory) {
          await visit(entryPath)
        }
      }
    }
  }
  await visit(rootPath)
  return out
}
