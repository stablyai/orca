import type { Dirent } from 'node:fs'
import { extname, join } from 'node:path'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { PrioritySemaphore } from '../../shared/priority-semaphore'
import { isWslUncPath } from '../../shared/wsl-paths'
import { SessionNewestFiles } from './session-newest-files'
import type { SessionSidecarObservation } from './session-sidecar-stat'
import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { recordSessionScanIssue } from './session-scan-issues'
import type { FileWithMtime, SessionFileDiscovery } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

const NATIVE_DISCOVERY_CONCURRENCY = 4
const NATIVE_DISCOVERY_BATCH_SIZE = 16
const nativeDiscoverySlots = new PrioritySemaphore(8)

type SessionFileObservation =
  | { file: Omit<FileWithMtime, 'modifiedAt'>; sidecarPath?: string }
  | { issue: { path: string; message: string } }

async function withNativeDiscoverySlot<T>(read: () => Promise<T>): Promise<T> {
  const release = await nativeDiscoverySlots.acquire(0)
  try {
    return await read()
  } finally {
    release()
  }
}

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
  let paths: string[] = []
  let pending: Promise<SessionFileObservation[]> | null = null
  const native = !isWslUncPath(args.rootDir)

  function consume(observations: readonly SessionFileObservation[]): void {
    for (const observation of observations) {
      if ('issue' in observation) {
        recordSessionScanIssue(args.issues, { agent: args.agent, ...observation.issue })
        continue
      }
      if (observation.file.sidecar === 'unknown' && !refusedSidecar) {
        refusedSidecar = true
        recordSessionScanIssue(args.issues, {
          agent: args.agent,
          path: observation.sidecarPath ?? args.rootDir,
          message: 'Session metadata could not be read this scan.'
        })
      }
      try {
        const modifiedAt = new Date(observation.file.mtimeMs)
        if (Number.isNaN(modifiedAt.getTime()) || files.wouldRetain(observation.file.mtimeMs)) {
          files.add({ ...observation.file, modifiedAt: modifiedAt.toISOString() })
        }
      } catch (err) {
        recordSessionScanIssue(args.issues, {
          agent: args.agent,
          path: observation.file.path,
          message: errorMessage(err)
        })
      }
    }
  }

  async function finishPending(): Promise<void> {
    if (pending) {
      consume(await pending)
      pending = null
    }
  }

  function queueNativeFile(path: string): void | Promise<void> {
    paths.push(path)
    if (paths.length < NATIVE_DISCOVERY_BATCH_SIZE) {
      return
    }
    return finishPending().then(() => {
      pending = readBatch(paths)
      paths = []
    })
  }

  async function readBatch(batch: readonly string[]): Promise<SessionFileObservation[]> {
    const groups: string[][] = []
    const groupSize = Math.ceil(batch.length / NATIVE_DISCOVERY_CONCURRENCY)
    for (let index = 0; index < batch.length; index += groupSize) {
      groups.push(batch.slice(index, index + groupSize))
    }
    const observations = await mapWithConcurrency(groups, NATIVE_DISCOVERY_CONCURRENCY, (group) =>
      withNativeDiscoverySlot(async () => {
        const files: SessionFileObservation[] = []
        for (const path of group) {
          files.push(await observeSessionFile(path, args.contentDependencyPath))
        }
        return files
      })
    )
    return observations.flat()
  }

  try {
    try {
      await forEachSessionFile(
        args.rootDir,
        args.agent,
        args.issues,
        {
          extensions: new Set(args.extensions),
          filePredicate: args.filePredicate,
          directoryPredicate: args.directoryPredicate,
          ...(native
            ? {
                readDirectory: (path: string) =>
                  withNativeDiscoverySlot(() => wslGatedReaddir(path, 'scan'))
              }
            : {})
        },
        native
          ? queueNativeFile
          : async (path) => consume([await observeSessionFile(path, args.contentDependencyPath)])
      )
    } finally {
      // One read batch overlaps directory traversal; commit in traversal order.
      await finishPending()
      if (paths.length) {
        consume(await readBatch(paths))
      }
    }
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

async function observeSessionFile(
  path: string,
  contentDependencyPath?: (path: string) => string | undefined | Promise<string | undefined>
): Promise<SessionFileObservation> {
  try {
    const fileStat = await wslGatedStat(path, 'scan')
    const sidecarPath = contentDependencyPath ? await contentDependencyPath(path) : undefined
    const sidecar = sidecarPath ? await observeSessionSidecar(sidecarPath) : 'none'
    return {
      file: {
        path,
        mtimeMs: fileStat.mtimeMs,
        sizeBytes: fileStat.size,
        sidecar,
        dev: fileStat.dev,
        ino: fileStat.ino,
        nlink: fileStat.nlink
      },
      sidecarPath
    }
  } catch (err) {
    return { issue: { path, message: errorMessage(err) } }
  }
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
  onFile: (path: string) => void | Promise<void>,
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
      const observation = onFile(fullPath)
      if (observation) {
        await observation
      }
    }
  }
}
