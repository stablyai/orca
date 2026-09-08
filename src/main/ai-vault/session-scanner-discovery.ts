import type { Dirent } from 'node:fs'
import { SessionNewestFiles } from './session-newest-files'
import { extname, join } from 'node:path'
import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { recordSessionScanIssue } from './session-scan-issues'
import type { SessionFileDiscovery } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

export async function discoverFiles(args: {
  rootDir: string
  signal?: AbortSignal
  limit: number
  agent: AiVaultAgent
  issues: AiVaultScanIssue[]
  extensions: string[]
  filePredicate?: (path: string) => boolean
  contentDependencyPath?: (path: string) => string | undefined | Promise<string | undefined>
  directoryPredicate?: (name: string, depth: number) => boolean
}): Promise<SessionFileDiscovery> {
  const files = new SessionNewestFiles(args.limit)
  try {
    await forEachSessionFile(
      args.rootDir,
      args.agent,
      args.issues,
      {
        extensions: new Set(args.extensions),
        signal: args.signal,
        filePredicate: args.filePredicate,
        directoryPredicate: args.directoryPredicate
      },
      async (path) => {
        args.signal?.throwIfAborted()
        try {
          const fileStat = await wslGatedStat(path, 'scan')
          const dependencyStat = await optionalContentDependencyStat(
            await args.contentDependencyPath?.(path)
          )
          args.signal?.throwIfAborted()
          const mtimeMs = Math.max(fileStat.mtimeMs, dependencyStat?.mtimeMs ?? 0)
          files.add({
            path,
            mtimeMs,
            modifiedAt: new Date(mtimeMs).toISOString(),
            sizeBytes: fileStat.size + (dependencyStat?.size ?? 0),
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
    )
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
  return { agent: args.agent, rootDir: args.rootDir, files: files.newest() }
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

export type SessionFileWalkOptions = {
  extensions: Set<string>
  filePredicate?: (path: string) => boolean
  // Return false to skip descending into a directory; depth 0 is a child of
  // rootDir, so pruned subtrees are never stat'd or parsed.
  directoryPredicate?: (name: string, depth: number) => boolean
  readDirectory?: (dirPath: string) => Promise<Dirent[]>
  signal?: AbortSignal
}

/** Collecting form for callers that want every match; large scans use `forEachSessionFile`. */
export async function walkSessionFiles(
  dirPath: string,
  agent: AiVaultAgent,
  issues: AiVaultScanIssue[],
  options: SessionFileWalkOptions
): Promise<string[]> {
  const files: string[] = []
  await forEachSessionFile(dirPath, agent, issues, options, async (path) => {
    files.push(path)
  })
  return files
}

/** Streams matches to `onFile` so a bounded consumer never retains the whole tree. */
export async function forEachSessionFile(
  dirPath: string,
  agent: AiVaultAgent,
  issues: AiVaultScanIssue[],
  options: SessionFileWalkOptions,
  onFile: (path: string) => Promise<void>,
  depth = 0
): Promise<void> {
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
    return
  }

  for (const entry of entries) {
    options.signal?.throwIfAborted()
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      // Skip whole subtrees an agent never wants (e.g. subagent transcripts),
      // avoiding the readdir cost of descending into them.
      if (options.directoryPredicate?.(entry.name, depth) ?? true) {
        await forEachSessionFile(fullPath, agent, issues, options, onFile, depth + 1)
      }
      continue
    }
    if (
      entry.isFile() &&
      options.extensions.has(extname(entry.name).toLowerCase()) &&
      (options.filePredicate?.(fullPath) ?? true)
    ) {
      await onFile(fullPath)
    }
  }
}
