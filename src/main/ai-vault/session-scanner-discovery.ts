import type { Dirent } from 'node:fs'
import { extname, join } from 'node:path'
import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  wslGatedOpendir,
  wslGatedReaddir,
  wslGatedStat
} from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { recordSessionScanIssue } from './session-scan-issues'
import type { FileWithMtime, SessionFileDiscovery } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

export type SessionDiscoveryBudget = {
  entriesRemaining: number
  filesRemaining: number
  truncated: boolean
  entriesTruncated: boolean
  filesTruncated: boolean
  directoriesRead: number
  direntsRead: number
}

export async function discoverFiles(args: {
  rootDir: string
  limit: number
  agent: AiVaultAgent
  issues: AiVaultScanIssue[]
  extensions: string[]
  filePredicate?: (path: string) => boolean
  directoryPredicate?: (name: string, depth: number) => boolean
  signal?: AbortSignal
  budget?: SessionDiscoveryBudget
}): Promise<SessionFileDiscovery> {
  let paths: string[]
  try {
    paths = await walkSessionFiles(args.rootDir, args.agent, args.issues, {
      extensions: new Set(args.extensions),
      filePredicate: args.filePredicate,
      directoryPredicate: args.directoryPredicate,
      signal: args.signal,
      budget: args.budget
    })
  } catch (err) {
    // Why: discoverAiVaultSessionSources fans out with Promise.all, so one
    // stalled distro would otherwise reject the whole vault scan — including
    // every healthy local agent. Contain it to this root.
    if (!(err instanceof WslTranscriptFsError)) {
      throw err
    }
    recordSessionScanIssue(args.issues, {
      agent: args.agent,
      path: args.rootDir,
      message: err.message
    })
    return { agent: args.agent, rootDir: args.rootDir, files: [] }
  }
  const files: FileWithMtime[] = []
  for (const path of paths) {
    if (args.budget && args.budget.filesRemaining <= 0) {
      args.budget.truncated = true
      args.budget.filesTruncated = true
      break
    }
    if (args.budget) {
      args.budget.filesRemaining--
    }
    try {
      const fileStat = await wslGatedStat(path, 'scan', args.signal)
      files.push({
        path,
        mtimeMs: fileStat.mtimeMs,
        modifiedAt: fileStat.mtime.toISOString(),
        sizeBytes: fileStat.size,
        dev: fileStat.dev,
        ino: fileStat.ino,
        nlink: fileStat.nlink
      })
    } catch (err) {
      args.signal?.throwIfAborted()
      recordSessionScanIssue(args.issues, {
        agent: args.agent,
        path,
        message: errorMessage(err)
      })
    }
  }
  return {
    agent: args.agent,
    rootDir: args.rootDir,
    files: files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, args.limit)
  }
}

export async function walkSessionFiles(
  dirPath: string,
  agent: AiVaultAgent,
  issues: AiVaultScanIssue[],
  options: {
    extensions: Set<string>
    filePredicate?: (path: string) => boolean
    // Return false to skip descending into a directory; depth 0 is a child of
    // rootDir, so pruned subtrees are never stat'd or parsed.
    directoryPredicate?: (name: string, depth: number) => boolean
    readDirectory?: (dirPath: string) => Promise<Dirent[]>
    signal?: AbortSignal
    budget?: SessionDiscoveryBudget
  },
  depth = 0
): Promise<string[]> {
  options.signal?.throwIfAborted()
  if (options.budget && options.budget.entriesRemaining <= 0) {
    options.budget.truncated = true
    options.budget.entriesTruncated = true
    return []
  }
  let entries
  try {
    entries = options.readDirectory
      ? await options.readDirectory(dirPath)
      : options.budget
        ? await readBoundedDirectoryEntries(dirPath, options.budget, options.signal)
        : await wslGatedReaddir(dirPath, 'scan', options.signal)
  } catch (error) {
    options.signal?.throwIfAborted()
    // Why: a gate refusal means the scan could not run, not that the tree is
    // empty — swallowing it would misreport a stalled distro as "no transcript".
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    options.signal?.throwIfAborted()
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      // Skip whole subtrees an agent never wants (e.g. subagent transcripts),
      // avoiding the readdir cost of descending into them.
      if (options.directoryPredicate?.(entry.name, depth) ?? true) {
        files.push(...(await walkSessionFiles(fullPath, agent, issues, options, depth + 1)))
      }
      continue
    }
    if (
      entry.isFile() &&
      options.extensions.has(extname(entry.name).toLowerCase()) &&
      (options.filePredicate?.(fullPath) ?? true)
    ) {
      files.push(fullPath)
    }
  }
  return files
}

async function readBoundedDirectoryEntries(
  dirPath: string,
  budget: SessionDiscoveryBudget,
  signal?: AbortSignal
): Promise<Dirent[]> {
  const directory = await wslGatedOpendir(dirPath, 'scan', signal)
  budget.directoriesRead += 1
  const entries: Dirent[] = []
  const iterator = directory[Symbol.asyncIterator]()
  try {
    while (true) {
      signal?.throwIfAborted()
      const next = await iterator.next()
      if (!next.done) {
        budget.direntsRead += 1
      }
      signal?.throwIfAborted()
      if (next.done) {
        break
      }
      if (budget.entriesRemaining <= 0) {
        budget.truncated = true
        budget.entriesTruncated = true
        break
      }
      budget.entriesRemaining--
      entries.push(next.value)
    }
  } finally {
    await directory.close().catch(() => undefined)
  }
  return entries
}
