import type { Dirent } from 'node:fs'
import { extname, join } from 'node:path'
import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { recordSessionScanIssue } from './session-scan-issues'
import type { FileWithMtime, SessionFileDiscovery } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

export async function discoverFiles(args: {
  rootDir: string
  limit: number
  agent: AiVaultAgent
  issues: AiVaultScanIssue[]
  extensions: string[]
  filePredicate?: (path: string) => boolean
  contentDependencyPath?: (path: string) => string
  directoryPredicate?: (name: string, depth: number) => boolean
}): Promise<SessionFileDiscovery> {
  let paths: string[]
  try {
    paths = await walkSessionFiles(args.rootDir, args.agent, args.issues, {
      extensions: new Set(args.extensions),
      filePredicate: args.filePredicate,
      directoryPredicate: args.directoryPredicate
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
    try {
      const fileStat = await wslGatedStat(path, 'scan')
      const dependencyStat = await optionalContentDependencyStat(args.contentDependencyPath?.(path))
      const mtimeMs = Math.max(fileStat.mtimeMs, dependencyStat?.mtimeMs ?? 0)
      files.push({
        path,
        mtimeMs,
        modifiedAt: new Date(mtimeMs).toISOString(),
        sizeBytes: fileStat.size + (dependencyStat?.size ?? 0),
        dev: fileStat.dev,
        ino: fileStat.ino,
        nlink: fileStat.nlink
      })
    } catch (err) {
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

async function optionalContentDependencyStat(
  filePath: string | undefined
): Promise<{ mtimeMs: number; size: number } | null> {
  if (!filePath) {
    return null
  }
  try {
    const fileStat = await wslGatedStat(filePath, 'scan')
    return { mtimeMs: fileStat.mtimeMs, size: fileStat.size }
  } catch (error) {
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return null
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
  },
  depth = 0
): Promise<string[]> {
  options.signal?.throwIfAborted()
  let entries
  try {
    entries = options.readDirectory
      ? await options.readDirectory(dirPath)
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
