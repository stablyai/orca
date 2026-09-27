import { createInterface } from 'node:readline'
import { extname, join } from 'node:path'
import {
  openTranscriptReadStream,
  wslGatedReaddir,
  wslGatedStat
} from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import type { CwdBucketLayout } from './session-cwd-bucket-layouts'
import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { recordSessionScanIssue } from './session-scan-issues'
import type { FileWithMtime } from './session-scanner-types'
import { errorMessage, extractString, parseJsonObject } from './session-scanner-values'

// Reading a few lines of one transcript per project dir is enough to learn that
// dir's cwd; cap both so a giant or cwd-less transcript can't stall the scan.
const REPRESENTATIVE_CWD_LINE_LIMIT = 200
const REPRESENTATIVE_FILE_LIMIT = 3
const TRANSCRIPT_EXTENSIONS = new Set(['.jsonl'])

// Both encodings are lossy; retain Claude’s existing cache and verify each Pi transcript.
const PROJECT_DIR_CWD_CACHE_MAX = 2048
const projectDirCwdCache = new Map<string, string>()

export function resetProjectDirCwdCacheForTests(): void {
  projectDirCwdCache.clear()
}

// A gate refusal is a stalled WSL root, not an empty one: keep the existing
// degrade-to-empty containment but make the gap visible in the scan issues.
function recordRefusal(
  issues: AiVaultScanIssue[],
  path: string,
  error: unknown,
  agent: AiVaultAgent
): void {
  if (error instanceof WslTranscriptFsError) {
    recordSessionScanIssue(issues, { agent, path, message: error.message })
  }
}

async function cachedProjectDirCwd(
  projectDir: string,
  issues: AiVaultScanIssue[],
  agent: AiVaultAgent
): Promise<string | null> {
  const cached = projectDirCwdCache.get(projectDir)
  if (cached !== undefined) {
    // Refresh recency so hot in-scope dirs outlive one-off ones at the cap.
    projectDirCwdCache.delete(projectDir)
    projectDirCwdCache.set(projectDir, cached)
    return cached
  }
  const cwd = await readProjectDirCwd(projectDir, issues, agent)
  if (cwd) {
    if (projectDirCwdCache.size >= PROJECT_DIR_CWD_CACHE_MAX) {
      const oldest = projectDirCwdCache.keys().next()
      if (!oldest.done) {
        projectDirCwdCache.delete(oldest.value)
      }
    }
    projectDirCwdCache.set(projectDir, cwd)
  }
  return cwd
}

type InScopeDiscoveryArgs = {
  rootDirs: readonly string[]
  scopePaths: readonly string[]
  limit: number
  excludedFilePaths: ReadonlySet<string>
  issues: AiVaultScanIssue[]
}

/**
 * Fully include the transcripts of cwd-bucket directories (Claude, Pi) whose cwd
 * falls inside the active workspace/project paths.
 *
 * Why: these agents keep one directory per cwd, e.g. `~/.claude/projects/<cwd-encoded>/`.
 * The global scan is recency-capped, so a project the user hasn't touched recently
 * can drop off the list entirely even though the agent's own resume still finds it.
 * For scoped panel views we resolve each bucket's cwd cheaply and bypass the cap for
 * the ones that belong to the active scope.
 */
export async function discoverInScopeCwdBucketFiles(
  layout: CwdBucketLayout,
  args: InScopeDiscoveryArgs
): Promise<FileWithMtime[]> {
  if (args.scopePaths.length === 0 || args.limit <= 0) {
    return []
  }
  const scopeProjectPrefixes = cwdBucketScopePrefixes(layout, args.scopePaths)
  const collected = new Map<string, FileWithMtime>()
  for (const rootDir of args.rootDirs) {
    for (const projectDir of await listProjectDirs(
      layout,
      rootDir,
      scopeProjectPrefixes,
      args.issues
    )) {
      if (layout.agent === 'claude') {
        const cwd = await cachedProjectDirCwd(projectDir, args.issues, layout.agent)
        if (!cwd || !args.scopePaths.some((scopePath) => isCwdInsideScopePath(scopePath, cwd))) {
          continue
        }
      }
      await collectBucketFiles({
        agent: layout.agent,
        scopePaths: layout.agent === 'pi' ? args.scopePaths : undefined,
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

function cwdBucketScopePrefixes(
  layout: CwdBucketLayout,
  scopePaths: readonly string[]
): Set<string> {
  const prefixes = new Set<string>()
  for (const scopePath of scopePaths) {
    for (const candidate of scopePathCandidates(scopePath)) {
      for (const prefix of layout.encodeScopePrefixes(candidate)) {
        prefixes.add(prefix)
      }
    }
  }
  return prefixes
}

function scopePathCandidates(scopePath: string): string[] {
  const wslScopePath = parseWslUncPath(scopePath)
  return wslScopePath ? [scopePath, wslScopePath.linuxPath] : [scopePath]
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
  layout: CwdBucketLayout,
  rootDir: string,
  scopeProjectPrefixes: ReadonlySet<string>,
  issues: AiVaultScanIssue[]
): Promise<string[]> {
  let entries
  try {
    entries = await wslGatedReaddir(rootDir, 'scan')
  } catch (err) {
    recordRefusal(issues, rootDir, err, layout.agent)
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && layout.isDirInScope(entry.name, scopeProjectPrefixes))
    .map((entry) => join(rootDir, entry.name))
}

async function readProjectDirCwd(
  projectDir: string,
  issues: AiVaultScanIssue[],
  agent: AiVaultAgent
): Promise<string | null> {
  const files = await newestTranscriptsInDir(projectDir, issues, agent)
  for (const file of files.slice(0, REPRESENTATIVE_FILE_LIMIT)) {
    const cwd = await readFirstCwd(file, issues, agent)
    if (cwd) {
      return cwd
    }
  }
  return null
}

async function newestTranscriptsInDir(
  projectDir: string,
  issues: AiVaultScanIssue[],
  agent: AiVaultAgent
): Promise<string[]> {
  let entries
  try {
    entries = await wslGatedReaddir(projectDir, 'scan')
  } catch (err) {
    recordRefusal(issues, projectDir, err, agent)
    return []
  }
  const newest: { path: string; mtimeMs: number }[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !TRANSCRIPT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      continue
    }
    const path = join(projectDir, entry.name)
    try {
      addBoundedPath(newest, REPRESENTATIVE_FILE_LIMIT, {
        path,
        mtimeMs: (await wslGatedStat(path, 'scan')).mtimeMs
      })
    } catch (err) {
      // Best effort: unreadable candidates are ignored here and reported during
      // full collection if the project directory proves in-scope.
      recordRefusal(issues, path, err, agent)
    }
  }
  return newest.sort((left, right) => right.mtimeMs - left.mtimeMs).map((value) => value.path)
}

async function readFirstCwd(
  filePath: string,
  issues: AiVaultScanIssue[],
  agent: AiVaultAgent
): Promise<string | null> {
  const input = openTranscriptReadStream(filePath, { encoding: 'utf-8' }, 'scan')
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
  } catch (err) {
    recordRefusal(issues, filePath, err, agent)
    return null
  } finally {
    // readline.close() leaves the underlying stream open; destroy it so the early
    // break/catch paths don't leak a file descriptor (this runs per project dir).
    lines.close()
    input.destroy()
  }
  return null
}

async function collectBucketFiles(args: {
  agent: AiVaultAgent
  scopePaths?: readonly string[]
  projectDir: string
  issues: AiVaultScanIssue[]
  collected: Map<string, FileWithMtime>
  limit: number
  excludedFilePaths: ReadonlySet<string>
}): Promise<void> {
  let entries
  try {
    entries = await wslGatedReaddir(args.projectDir, 'scan')
  } catch (err) {
    recordRefusal(args.issues, args.projectDir, err, args.agent)
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !TRANSCRIPT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      continue
    }
    const path = join(args.projectDir, entry.name)
    if (args.collected.has(path) || args.excludedFilePaths.has(path)) {
      continue
    }
    try {
      if (args.scopePaths) {
        const cwd = await readFirstCwd(path, args.issues, args.agent)
        if (!cwd || !args.scopePaths.some((scope) => isCwdInsideScopePath(scope, cwd))) {
          continue
        }
      }
      const fileStat = await wslGatedStat(path, 'scan')
      addBoundedFile(args.collected, args.limit, {
        path,
        mtimeMs: fileStat.mtimeMs,
        modifiedAt: fileStat.mtime.toISOString(),
        sizeBytes: fileStat.size
      })
    } catch (err) {
      recordSessionScanIssue(args.issues, { agent: args.agent, path, message: errorMessage(err) })
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
