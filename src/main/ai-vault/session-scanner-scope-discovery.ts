import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { extname, join } from 'node:path'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { FileWithMtime } from './session-scanner-types'
import { errorMessage, extractString, parseJsonObject } from './session-scanner-values'

// Reading a few lines of one transcript per project dir is enough to learn that
// dir's cwd; cap both so a giant or cwd-less transcript can't stall the scan.
const REPRESENTATIVE_CWD_LINE_LIMIT = 200
const REPRESENTATIVE_FILE_LIMIT = 3
const CLAUDE_EXTENSIONS = new Set(['.jsonl'])

/**
 * Fully include the transcripts of Claude project directories whose cwd falls
 * inside the active workspace/project paths.
 *
 * Why: Claude organizes `~/.claude/projects/<cwd-encoded>/` one directory per
 * cwd. The global scan is recency-capped, so a project the user hasn't touched
 * recently can drop off the list entirely even though `claude --resume` still
 * finds it. For scoped panel views we resolve each project dir's cwd cheaply and
 * bypass the cap for the ones that belong to the active scope.
 */
export async function discoverInScopeClaudeFiles(args: {
  rootDirs: readonly string[]
  scopePaths: readonly string[]
  limit: number
  excludedFilePaths: ReadonlySet<string>
  issues: AiVaultScanIssue[]
}): Promise<FileWithMtime[]> {
  if (args.scopePaths.length === 0 || args.limit <= 0) {
    return []
  }
  const scopeProjectPrefixes = claudeProjectScopePrefixes(args.scopePaths)
  const collected = new Map<string, FileWithMtime>()
  for (const rootDir of args.rootDirs) {
    for (const projectDir of await listProjectDirs(rootDir, scopeProjectPrefixes)) {
      const cwd = await readProjectDirCwd(projectDir)
      if (!cwd || !args.scopePaths.some((scopePath) => isCwdInsideScopePath(scopePath, cwd))) {
        continue
      }
      await collectClaudeFiles({
        projectDir,
        issues: args.issues,
        collected,
        limit: args.limit,
        excludedFilePaths: args.excludedFilePaths
      })
    }
  }
  return [...collected.values()].sort((left, right) => right.mtimeMs - left.mtimeMs)
}

function claudeProjectScopePrefixes(scopePaths: readonly string[]): Set<string> {
  const prefixes = new Set<string>()
  for (const scopePath of scopePaths) {
    for (const candidate of scopePathCandidates(scopePath)) {
      prefixes.add(encodeClaudeProjectPath(candidate))
    }
  }
  return prefixes
}

function scopePathCandidates(scopePath: string): string[] {
  const wslScopePath = parseWslUncPath(scopePath)
  return wslScopePath ? [scopePath, wslScopePath.linuxPath] : [scopePath]
}

function encodeClaudeProjectPath(pathValue: string): string {
  return normalizeRuntimePathForComparison(pathValue).replace(/[^a-zA-Z0-9]/g, '-')
}

function isClaudeProjectDirInScope(projectDirName: string, scopePrefixes: ReadonlySet<string>) {
  for (const prefix of scopePrefixes) {
    if (projectDirName === prefix || projectDirName.startsWith(`${prefix}-`)) {
      return true
    }
  }
  return false
}

function isCwdInsideScopePath(scopePath: string, cwd: string): boolean {
  if (isPathInsideOrEqual(scopePath, cwd)) {
    return true
  }

  const wslScopePath = parseWslUncPath(scopePath)
  if (!wslScopePath) {
    return false
  }

  // WSL transcripts record Linux cwd values even when the renderer sends the
  // active worktree as a Windows UNC path.
  return isPathInsideOrEqual(wslScopePath.linuxPath, cwd)
}

async function listProjectDirs(
  rootDir: string,
  scopeProjectPrefixes: ReadonlySet<string>
): Promise<string[]> {
  let entries
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(
      (entry) => entry.isDirectory() && isClaudeProjectDirInScope(entry.name, scopeProjectPrefixes)
    )
    .map((entry) => join(rootDir, entry.name))
}

async function readProjectDirCwd(projectDir: string): Promise<string | null> {
  const files = await newestClaudeFilesInDir(projectDir)
  for (const file of files.slice(0, REPRESENTATIVE_FILE_LIMIT)) {
    const cwd = await readFirstCwd(file)
    if (cwd) {
      return cwd
    }
  }
  return null
}

async function newestClaudeFilesInDir(projectDir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(projectDir, { withFileTypes: true })
  } catch {
    return []
  }
  const newest: { path: string; mtimeMs: number }[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !CLAUDE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      continue
    }
    const path = join(projectDir, entry.name)
    try {
      addBoundedPath(newest, REPRESENTATIVE_FILE_LIMIT, {
        path,
        mtimeMs: (await stat(path)).mtimeMs
      })
    } catch {
      // Best effort: unreadable candidates are ignored here and reported during
      // full collection if the project directory proves in-scope.
    }
  }
  return newest.sort((left, right) => right.mtimeMs - left.mtimeMs).map((value) => value.path)
}

async function readFirstCwd(filePath: string): Promise<string | null> {
  const input = createReadStream(filePath, { encoding: 'utf-8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let read = 0
  try {
    for await (const line of lines) {
      if (read++ >= REPRESENTATIVE_CWD_LINE_LIMIT) {
        break
      }
      const cwd = extractString(parseJsonObject(line)?.cwd)
      if (cwd) {
        return cwd
      }
    }
  } catch {
    return null
  } finally {
    // readline.close() leaves the underlying stream open; destroy it so the early
    // break/catch paths don't leak a file descriptor (this runs per project dir).
    lines.close()
    input.destroy()
  }
  return null
}

async function collectClaudeFiles(args: {
  projectDir: string
  issues: AiVaultScanIssue[]
  collected: Map<string, FileWithMtime>
  limit: number
  excludedFilePaths: ReadonlySet<string>
}): Promise<void> {
  let entries
  try {
    entries = await readdir(args.projectDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !CLAUDE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      continue
    }
    const path = join(args.projectDir, entry.name)
    if (args.collected.has(path) || args.excludedFilePaths.has(path)) {
      continue
    }
    try {
      const fileStat = await stat(path)
      addBoundedFile(args.collected, args.limit, {
        path,
        mtimeMs: fileStat.mtimeMs,
        modifiedAt: fileStat.mtime.toISOString()
      })
    } catch (err) {
      args.issues.push({ agent: 'claude', path, message: errorMessage(err) })
    }
  }
}

function addBoundedFile(
  collected: Map<string, FileWithMtime>,
  limit: number,
  file: FileWithMtime
): void {
  if (collected.size < limit) {
    collected.set(file.path, file)
    return
  }

  let oldest: FileWithMtime | null = null
  for (const candidate of collected.values()) {
    if (!oldest || candidate.mtimeMs < oldest.mtimeMs) {
      oldest = candidate
    }
  }
  if (oldest && file.mtimeMs > oldest.mtimeMs) {
    collected.delete(oldest.path)
    collected.set(file.path, file)
  }
}

function addBoundedPath<T extends { mtimeMs: number }>(items: T[], limit: number, item: T): void {
  if (items.length < limit) {
    items.push(item)
    return
  }

  let oldestIndex = 0
  for (let index = 1; index < items.length; index++) {
    if (items[index].mtimeMs < items[oldestIndex].mtimeMs) {
      oldestIndex = index
    }
  }
  if (item.mtimeMs > items[oldestIndex].mtimeMs) {
    items[oldestIndex] = item
  }
}
