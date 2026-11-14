import type { Dirent } from 'node:fs'
import { extname, join } from 'node:path'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { SessionNewestFiles } from './session-newest-files'
import type { SessionSidecarObservation } from '../parse-cache/session-sidecar-stat'
import type {
  AiVaultAgent,
  AiVaultScanIssue
} from '../../../shared/ai-vault/contracts/ai-vault-types'
import {
  wslGatedReaddir,
  wslGatedStat
} from '../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../../native-chat/transcript-filesystem/wsl-transcript-fs-error'
import { recordSessionScanIssue, scanIssueTextFromError } from '../parsing/session-scan-issues'
import { aiVaultScanIssueText } from '../../../shared/ai-vault/scanning/ai-vault-scan-issue-copy'
import type {
  FileWithMtime,
  SessionFileDiscovery,
  SessionFileWalkOptions
} from '../session-scanner-types'
import { errorMessage } from '../../../shared/error-message'
import { throwIfAiVaultScanCancelled } from '../scan-lifecycle/ai-vault-scan-cancellation'
import {
  noteAiVaultScanFileFound,
  noteAiVaultScanWorkChanged,
  openAiVaultScanSource
} from '../scan-lifecycle/ai-vault-scan-progress'
import { isMissingTranscriptPathError } from './session-path-absence'

const NATIVE_DISCOVERY_CONCURRENCY = 4
const NATIVE_DISCOVERY_BATCH_SIZE = 16
const nativeDiscoverySlots = new PrioritySemaphore(8)

type SessionFileObservation =
  | { file: Omit<FileWithMtime, 'modifiedAt'>; sidecarPath?: string }
  | { issue: Omit<AiVaultScanIssue, 'agent' | 'kind' | 'executionHostId'> }

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
  selectFiles?: (files: readonly FileWithMtime[]) => FileWithMtime[]
  contentDependencyPath?: (path: string) => string | undefined | Promise<string | undefined>
  directoryPredicate?: (name: string, depth: number) => boolean
  // Sees each listing the walk already made, so callers can read layout without another readdir.
  onDirectoryEntries?: (dirPath: string, entries: readonly Dirent[]) => void
  // A scoped scan walks every file this agent has, not only the newest `limit`.
  keepScopeFiles?: boolean
  signal?: AbortSignal
}): Promise<SessionFileDiscovery> {
  // Selection needs every candidate, so an opting agent collects first and limits after.
  const selectFiles = args.selectFiles
  const files = new SessionNewestFiles(selectFiles ? Number.POSITIVE_INFINITY : args.limit)
  const scopeFiles: FileWithMtime[] | undefined = args.keepScopeFiles ? [] : undefined
  let refusedSidecar = false
  let paths: string[] = []
  let pending: Promise<SessionFileObservation[]> | null = null
  const native = !isWslUncPath(args.rootDir)
  const source = { close: (): void => undefined }

  function consume(observations: readonly SessionFileObservation[]): void {
    // A stat the cancel cut short is not an unreadable file; never record it.
    throwIfAiVaultScanCancelled(args.signal)
    for (const observation of observations) {
      if ('issue' in observation) {
        recordSessionScanIssue(args.issues, {
          agent: args.agent,
          ...observation.issue
        })
        continue
      }
      noteAiVaultScanFileFound(args.signal, args.agent, observation.file)
      if (observation.file.sidecar === 'unknown' && !refusedSidecar) {
        refusedSidecar = true
        recordSessionScanIssue(args.issues, {
          agent: args.agent,
          path: observation.sidecarPath ?? args.rootDir,
          ...aiVaultScanIssueText('sessionMetadataUnreadable')
        })
      }
      try {
        const modifiedAt = new Date(observation.file.mtimeMs)
        if (
          Number.isNaN(modifiedAt.getTime()) ||
          files.wouldRetain(observation.file.mtimeMs) ||
          scopeFiles
        ) {
          const left = files.add({
            ...observation.file,
            modifiedAt: modifiedAt.toISOString()
          })
          if (left) {
            scopeFiles?.push(left)
          }
        }
      } catch (err) {
        recordSessionScanIssue(args.issues, {
          agent: args.agent,
          path: observation.file.path,
          message: errorMessage(err)
        })
      }
    }
    noteAiVaultScanWorkChanged(args.signal)
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
        // Break without rejecting an unawaited batch; consume propagates cancellation when it is awaited.
        for (const path of group) {
          if (args.signal?.aborted) {
            break
          }
          files.push(await observeSessionFile(path, args.contentDependencyPath, args.signal))
        }
        return files
      })
    )
    return observations.flat()
  }

  async function readDirectory(path: string): Promise<Dirent[]> {
    const entries = native
      ? await withNativeDiscoverySlot(() => wslGatedReaddir(path, 'scan', args.signal))
      : await wslGatedReaddir(path, 'scan', args.signal)
    // Report a source only after its root directory can be listed.
    if (path === args.rootDir) {
      source.close = openAiVaultScanSource(args.signal, args.agent)
    }
    args.onDirectoryEntries?.(path, entries)
    return entries
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
          signal: args.signal,
          readDirectory
        },
        native
          ? queueNativeFile
          : async (path) =>
              consume([await observeSessionFile(path, args.contentDependencyPath, args.signal)])
      )
    } finally {
      // One read batch overlaps directory traversal; commit in traversal order.
      await finishPending()
      if (paths.length) {
        consume(await readBatch(paths))
      }
    }
  } catch (err) {
    throwIfAiVaultScanCancelled(args.signal)
    // Contain WSL refusal to this root so Promise.all preserves healthy agents in the same scan.
    if (!(err instanceof WslTranscriptFsError)) {
      throw err
    }
    recordSessionScanIssue(args.issues, {
      agent: args.agent,
      path: args.rootDir,
      ...scanIssueTextFromError(err)
    })
    return { agent: args.agent, rootDir: args.rootDir, files: [] }
  } finally {
    source.close()
  }
  const selected = selectFiles ? selectFiles(files.newest()) : files.newest()
  const retained = selectFiles ? selected.slice(0, args.limit) : selected
  // Scope passes still see selected candidates beyond the recency limit.
  const overflow = selectFiles && scopeFiles ? selected.slice(args.limit) : scopeFiles
  return { agent: args.agent, rootDir: args.rootDir, files: retained, scopeFiles: overflow }
}

async function observeSessionFile(
  path: string,
  contentDependencyPath?: (path: string) => string | undefined | Promise<string | undefined>,
  signal?: AbortSignal
): Promise<SessionFileObservation> {
  try {
    const fileStat = await wslGatedStat(path, 'scan', signal)
    const sidecarPath = contentDependencyPath ? await contentDependencyPath(path) : undefined
    const sidecar = sidecarPath ? await observeSessionSidecar(sidecarPath, signal) : 'none'
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
    return { issue: { path, ...scanIssueTextFromError(err) } }
  }
}

/** Only missing sidecars are none; other stat failures stay unknown so cached enrichment can retry. */
async function observeSessionSidecar(
  filePath: string | undefined,
  signal?: AbortSignal
): Promise<SessionSidecarObservation> {
  if (!filePath) {
    return 'none'
  }
  try {
    const fileStat = await wslGatedStat(filePath, 'scan', signal)
    return {
      path: filePath,
      mtimeMs: fileStat.mtimeMs,
      sizeBytes: fileStat.size
    }
  } catch (error) {
    return isMissingTranscriptPathError(error) ? 'none' : 'unknown'
  }
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
    // Propagate gate refusal so stalled distros are not reported as empty trees.
    if (
      error instanceof WslTranscriptFsError ||
      (options.strictErrors && !isMissingTranscriptPathError(error))
    ) {
      throw error
    }
    return
  }

  for (const entry of entries) {
    options.signal?.throwIfAborted()
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
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
