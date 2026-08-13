import type { Dirent } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

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

export async function findSkillFiles(rootPath: string, maxDepth: number): Promise<string[]> {
  const out: string[] = []
  const visitedDirectoryPaths = new Set<string>()
  async function visit(dirPath: string): Promise<void> {
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
        try {
          if ((await stat(entryPath)).isDirectory()) {
            await visit(entryPath)
          }
        } catch {
          // Broken links are not valid skill directories.
        }
      }
    }
  }
  await visit(rootPath)
  return out
}
