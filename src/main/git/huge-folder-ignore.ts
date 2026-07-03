import { existsSync } from 'node:fs'
import { appendFile, readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { checkIgnoredPaths } from './check-ignored-paths'
import type { GitRuntimeOptions } from './git-runtime-options'

// Why: the overwhelmingly common cause of a status listing big enough to hit the
// entry limit is a dependency/build folder that should have been ignored. Offer
// to ignore these by name (matching the well-known offenders) the way a mature
// SCM does, rather than asking the user to hand-edit .gitignore.
const KNOWN_HUGE_FOLDER_NAMES = ['node_modules', '.next', 'dist', 'build', 'target', 'vendor']

/**
 * Return the relative names of known-huge folders that exist in the worktree and
 * are NOT already git-ignored — candidates to offer adding to .gitignore.
 */
export async function findKnownHugeFolderPathsToIgnore(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  const existing: string[] = []
  for (const name of KNOWN_HUGE_FOLDER_NAMES) {
    const full = path.join(worktreePath, name)
    if (!existsSync(full)) {
      continue
    }
    try {
      if ((await stat(full)).isDirectory()) {
        existing.push(name)
      }
    } catch {
      // ignore — folder vanished mid-check
    }
  }
  if (existing.length === 0) {
    return []
  }
  // Why: a folder already covered by an existing rule shouldn't be offered again.
  const ignored = new Set(await checkIgnoredPaths(worktreePath, existing, options).catch(() => []))
  return existing.filter((name) => !ignored.has(name))
}

/**
 * Append a folder pattern to the worktree's .gitignore (creating it if absent),
 * skipping the write if the exact line is already present. Returns true on write.
 *
 * `folderName` comes from the renderer, so it is restricted to the known-huge
 * allowlist (single path segment, no separators/newlines) before being written
 * — otherwise a crafted value could inject arbitrary lines into .gitignore.
 */
export async function appendFolderToGitignore(
  worktreePath: string,
  folderName: string
): Promise<boolean> {
  const safeFolderName = folderName.trim()
  if (!KNOWN_HUGE_FOLDER_NAMES.includes(safeFolderName) || /[\\/\r\n]/.test(safeFolderName)) {
    throw new Error(`Refusing to add unrecognized folder to .gitignore: ${folderName}`)
  }
  const gitignorePath = path.join(worktreePath, '.gitignore')
  const line = `${safeFolderName}/`
  let existingContent = ''
  try {
    existingContent = await readFile(gitignorePath, 'utf-8')
  } catch {
    // .gitignore doesn't exist yet — we'll create it below
  }
  const alreadyListed = existingContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l === safeFolderName || l === line)
  if (alreadyListed) {
    return false
  }
  // Why: keep a clean trailing newline whether or not the file ended with one.
  const needsLeadingNewline = existingContent.length > 0 && !existingContent.endsWith('\n')
  await appendFile(gitignorePath, `${needsLeadingNewline ? '\n' : ''}${line}\n`, 'utf-8')
  return true
}
