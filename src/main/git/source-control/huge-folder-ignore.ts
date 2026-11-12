import { existsSync } from 'node:fs'
import { appendFile, readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { checkIgnoredPaths } from './check-ignored-paths'
import type { GitRuntimeOptions } from '../command-runner/git-runtime-options'

// Offer common dependency/build folders when unignored content saturates status.
const KNOWN_HUGE_FOLDER_NAMES = [
  'node_modules',
  '.next',
  'dist',
  'build',
  'target',
  'vendor',
  '.dart_tool',
  '.gradle',
  '.turbo',
  'Pods'
]

export async function findKnownHugeFolderPathsToIgnore(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  const candidates = KNOWN_HUGE_FOLDER_NAMES.filter((name) =>
    existsSync(path.join(worktreePath, name))
  )
  // Fixed six-name allowlist, so the independent stats can all run at once.
  const isDirectory = await Promise.all(
    candidates.map((name) =>
      stat(path.join(worktreePath, name)).then(
        (stats) => stats.isDirectory(),
        () => false
      )
    )
  )
  const existing = candidates.filter((_, index) => isDirectory[index])
  if (existing.length === 0) {
    return []
  }
  const ignored = new Set(await checkIgnoredPaths(worktreePath, existing, options).catch(() => []))
  return existing.filter((name) => !ignored.has(name))
}

/** Append an allowlisted folder pattern once; reject renderer input that could inject arbitrary ignore lines. */
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
  } catch {}
  const alreadyListed = existingContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l === safeFolderName || l === line)
  if (alreadyListed) {
    return false
  }
  const needsLeadingNewline = existingContent.length > 0 && !existingContent.endsWith('\n')
  await appendFile(gitignorePath, `${needsLeadingNewline ? '\n' : ''}${line}\n`, 'utf-8')
  return true
}
