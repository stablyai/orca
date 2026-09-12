import type { Dirent } from 'node:fs'
import { extname, join } from 'node:path'
import { SessionNewestFiles } from './session-newest-files'
import type { SessionSidecarObservation } from './session-sidecar-stat'
import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { recordSessionScanIssue } from './session-scan-issues'
import type { SessionFileDiscovery } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

export async function discoverFiles(args: {
  rootDir: string
  limit: number
  agent: AiVaultAgent
  issues: AiVaultScanIssue[]
  extensions: string[]
  filePredicate?: (path: string) => boolean
  contentDependencyPath?: (path: string) => string | undefined | Promise<string | undefined>
  directoryPredicate?: (name: string, depth: number) => boolean
}): Promise<SessionFileDiscovery> {
  const files = new SessionNewestFiles(args.limit)
  let refusedSidecar = false
  try {
    await forEachSessionFile(
      args.rootDir,
      args.agent,
      args.issues,
      {
        extensions: new Set(args.extensions),
        filePredicate: args.filePredicate,
        directoryPredicate: args.directoryPredicate
      },
      async (path) => {
        try {
          const fileStat = await wslGatedStat(path, 'scan')
          const sidecarPath = await args.contentDependencyPath?.(path)
          const sidecar = await observeSessionSidecar(sidecarPath)
          if (sidecar === 'unknown' && !refusedSidecar) {
            // One issue per root: a refused sibling is a property of the tree,
            // not of each transcript that happens to point at it.
            refusedSidecar = true
            recordSessionScanIssue(args.issues, {
              agent: args.agent,
              path: sidecarPath ?? args.rootDir,
              message: 'Session metadata could not be read this scan.'
            })
          }
          files.add({
            path,
            mtimeMs: fileStat.mtimeMs,
            modifiedAt: new Date(fileStat.mtimeMs).toISOString(),
            sizeBytes: fileStat.size,
            sidecar,
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

/**
 * A sibling that cannot be statted is not "no sibling": it must not take the
 * transcript down with it, and it must not read as absent either, or the parse
 * cache would treat a session enriched from a file nobody can see as current
 * forever. Only a genuinely missing path is `'none'`; every other failure —
 * a stalled WSL distro, EACCES, EIO — is `'unknown'`.
 */
async function observeSessionSidecar(
  filePath: string | undefined
): Promise<SessionSidecarObservation> {
  if (!filePath) {
    return 'none'
  }
  try {
    const fileStat = await wslGatedStat(filePath, 'scan')
    return { path: filePath, mtimeMs: fileStat.mtimeMs, sizeBytes: fileStat.size }
  } catch (error) {
    return isMissingSidecarError(error) ? 'none' : 'unknown'
  }
}

function isMissingSidecarError(error: unknown): boolean {
  if (error instanceof WslTranscriptFsError) {
    return false
  }
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null
  return code === 'ENOENT' || code === 'ENOTDIR'
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

/** Collecting form for callers that want every match; bounded scans stream. */
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
