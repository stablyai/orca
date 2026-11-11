import { createInterface } from 'node:readline'
import { extname, join } from 'node:path'
import {
  openTranscriptReadStream,
  wslGatedReaddir,
  wslGatedStat
} from '../native-chat/wsl-transcript-fs-access'
import type { createAiVaultScopeCwdMatcher } from '../../shared/ai-vault/scanning/ai-vault-scope-cwd-match'
import type { CwdBucketLayout } from './session-cwd-bucket-layouts'
import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import { parseWslUncPath, toWindowsWslUncPathSpellings } from '../../shared/wsl-paths'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { yieldToEventLoop } from '../../shared/event-loop-yield'
import type { FileWithMtime } from './session-scanner-types'
import { extractString, parseJsonObject } from './session-scanner-values'
import { scanIssueTextFromError } from './session-scan-issues'
import { isMissingTranscriptPathError } from './session-scanner-discovery'
import { noteAiVaultScanFileFound } from './ai-vault-scan-progress'

// Limit representative probing when a bucket contains transcripts without cwd records.
const REPRESENTATIVE_CWD_LINE_LIMIT = 200
const REPRESENTATIVE_FILE_LIMIT = 3
const TRANSCRIPT_EXTENSIONS = new Set(['.jsonl'])

// Bucket encodings are lossy; retain Claude’s cache and verify other transcripts individually.
const PROJECT_DIR_CWD_CACHE_MAX = 2048
const projectDirCwdCache = new Map<string, string>()
export type IssueSink = (issue: AiVaultScanIssue, error?: unknown) => void

export function resetProjectDirCwdCacheForTests(): void {
  projectDirCwdCache.clear()
}

// Report refusals (WSL, permissions) so an unreadable folder or transcript is not mistaken for an empty one.
export function recordRefusal(
  issues: IssueSink,
  path: string,
  error: unknown,
  agent: AiVaultAgent
): void {
  if (!isMissingTranscriptPathError(error)) {
    issues({ agent, path, ...scanIssueTextFromError(error) }, error)
  }
}

export async function cachedProjectDirCwd(
  projectDir: string,
  issues: IssueSink,
  agent: AiVaultAgent,
  signal?: AbortSignal
): Promise<string | null> {
  const cached = projectDirCwdCache.get(projectDir)
  if (cached !== undefined) {
    // Refresh recency so hot in-scope dirs outlive one-off ones at the cap.
    projectDirCwdCache.delete(projectDir)
    projectDirCwdCache.set(projectDir, cached)
    return cached
  }
  const cwd = await readProjectDirCwd(projectDir, issues, agent, signal)
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

export function cwdBucketScopePrefixes(
  layout: CwdBucketLayout,
  scopePaths: readonly string[]
): Set<string> {
  const prefixes = new Set<string>()
  for (const scopePath of scopePaths) {
    // Encoders add the NFC spelling; a cwd recorded in NFD names its bucket differently.
    for (const candidate of scopePathCandidates(scopePath).flatMap((path) => [
      path,
      path.normalize('NFD')
    ])) {
      for (const prefix of layout.encodeScopePrefixes(candidate)) {
        prefixes.add(prefix.toLowerCase())
      }
    }
  }
  return prefixes
}

// A WSL share has two UNC spellings, and a transcript may record either one.
function scopePathCandidates(scopePath: string): string[] {
  const wsl = parseWslUncPath(scopePath)
  if (!wsl) {
    return [scopePath]
  }
  return [scopePath, wsl.linuxPath, ...toWindowsWslUncPathSpellings(wsl.linuxPath, wsl.distro)]
}

export async function listProjectDirs(
  layout: CwdBucketLayout,
  rootDir: string,
  scopeProjectPrefixes: ReadonlySet<string>,
  issues: IssueSink,
  signal?: AbortSignal,
  listed?: () => void
): Promise<string[]> {
  let entries
  try {
    entries = await wslGatedReaddir(rootDir, 'scan', signal)
    throwIfAiVaultScanCancelled(signal)
    listed?.()
  } catch (err) {
    throwIfAiVaultScanCancelled(signal)
    recordRefusal(issues, rootDir, err, layout.agent)
    return []
  }
  // Case-folded: Windows cwds differ in case, and each bucket's cwd is still checked afterwards.
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && layout.isDirInScope(entry.name.toLowerCase(), scopeProjectPrefixes)
    )
    .map((entry) => join(rootDir, entry.name))
}

async function readProjectDirCwd(
  projectDir: string,
  issues: IssueSink,
  agent: AiVaultAgent,
  signal?: AbortSignal
): Promise<string | null> {
  const files = await newestTranscriptsInDir(projectDir, issues, agent, signal)
  for (const file of files.slice(0, REPRESENTATIVE_FILE_LIMIT)) {
    const cwd = await readFirstCwd(file, issues, agent, signal)
    if (cwd) {
      return cwd
    }
  }
  return null
}

async function newestTranscriptsInDir(
  projectDir: string,
  issues: IssueSink,
  agent: AiVaultAgent,
  signal?: AbortSignal
): Promise<string[]> {
  let entries
  try {
    entries = await wslGatedReaddir(projectDir, 'scan', signal)
    throwIfAiVaultScanCancelled(signal)
  } catch (err) {
    throwIfAiVaultScanCancelled(signal)
    recordRefusal(issues, projectDir, err, agent)
    return []
  }
  const newest: { path: string; mtimeMs: number }[] = []
  for (const [index, entry] of entries.entries()) {
    if (index % 256 === 0) {
      await yieldToEventLoop()
    }
    throwIfAiVaultScanCancelled(signal)
    if (!entry.isFile() || !TRANSCRIPT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      continue
    }
    const path = join(projectDir, entry.name)
    try {
      addBoundedPath(newest, REPRESENTATIVE_FILE_LIMIT, {
        path,
        mtimeMs: (await wslGatedStat(path, 'scan', signal)).mtimeMs
      })
    } catch (err) {
      throwIfAiVaultScanCancelled(signal)
      recordRefusal(issues, path, err, agent)
    }
  }
  return newest.sort((left, right) => right.mtimeMs - left.mtimeMs).map((value) => value.path)
}

async function readFirstCwd(
  filePath: string,
  issues: IssueSink,
  agent: AiVaultAgent,
  signal?: AbortSignal
): Promise<string | null> {
  const input = openTranscriptReadStream(filePath, { encoding: 'utf-8' }, 'scan', signal)
  const lines = createInterface({ input, crlfDelay: Infinity })
  let read = 0
  try {
    throwIfAiVaultScanCancelled(signal)
    for await (const line of lines) {
      throwIfAiVaultScanCancelled(signal)
      if (read++ >= REPRESENTATIVE_CWD_LINE_LIMIT) {
        break
      }
      const cwd = extractString(parseJsonObject(line)?.cwd)
      if (cwd) {
        return cwd
      }
    }
  } catch (err) {
    throwIfAiVaultScanCancelled(signal)
    recordRefusal(issues, filePath, err, agent)
    return null
  } finally {
    // readline.close() leaves its input open; destroy the stream after early exits and read failures.
    lines.close()
    input.destroy()
  }
  return null
}

export async function collectBucketFiles(args: {
  paths: readonly string[]
  agent: AiVaultAgent
  inScope?: ReturnType<typeof createAiVaultScopeCwdMatcher>
  issues: IssueSink
  collected: Map<string, FileWithMtime>
  // Files whose first lines name no cwd go here, bounded on their own, instead of being dropped.
  unknown?: Map<string, FileWithMtime>
  limit: number
  excludedFilePaths: ReadonlySet<string>
  signal?: AbortSignal
}): Promise<void> {
  for (const [index, path] of args.paths.entries()) {
    if (index % 256 === 0) {
      await yieldToEventLoop()
    }
    throwIfAiVaultScanCancelled(args.signal)
    if (args.collected.has(path) || args.unknown?.has(path) || args.excludedFilePaths.has(path)) {
      continue
    }
    try {
      let collected = args.collected
      if (args.inScope) {
        const cwd = await readFirstCwd(path, args.issues, args.agent, args.signal)
        if (cwd === null && args.unknown) {
          collected = args.unknown
        } else if (!args.inScope(cwd, path)) {
          continue
        }
      }
      const fileStat = await wslGatedStat(path, 'scan', args.signal)
      throwIfAiVaultScanCancelled(args.signal)
      // Scope-only scans don't list cwd-bucket agents recursively, so their file count comes from here.
      noteAiVaultScanFileFound(args.signal, args.agent, {
        path,
        dev: fileStat.dev,
        ino: fileStat.ino
      })
      addBoundedFile(collected, args.limit, {
        path,
        mtimeMs: fileStat.mtimeMs,
        modifiedAt: fileStat.mtime.toISOString(),
        sizeBytes: fileStat.size
      })
    } catch (err) {
      throwIfAiVaultScanCancelled(args.signal)
      args.issues({ agent: args.agent, path, ...scanIssueTextFromError(err) })
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
