import type { Dirent } from 'node:fs'
import { extname, join } from 'node:path'
import { isSelectedSessionFile } from './session-scanner-selection'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { PrioritySemaphore } from '../../shared/priority-semaphore'
import { isWslUncPath } from '../../shared/wsl-paths'
import {
  observeSessionFile,
  isMissingSidecarError,
  type SessionFileObservation
} from './session-file-observation'
import { errorMessage } from './session-scanner-values'
import { SessionNewestFiles } from './session-newest-files'
import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { recordSessionScanIssue, scanIssueTextFromError } from './session-scan-issues'
import { aiVaultScanIssueText } from '../../shared/ai-vault-scan-issue-copy'
import type { FileWithMtime, SessionFileDiscovery } from './session-scanner-types'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import {
  noteAiVaultScanFileFound,
  noteAiVaultScanWorkChanged,
  openAiVaultScanSource
} from './ai-vault-scan-progress'

const NATIVE_DISCOVERY_CONCURRENCY = 4
const NATIVE_DISCOVERY_BATCH_SIZE = 16
const nativeDiscoverySlots = new PrioritySemaphore(8)

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
  // A scoped scan walks every file this agent has, not only the newest `limit`.
  keepScopeFiles?: boolean
  selectedSessionId?: string
  executionHostId?: string
  signal?: AbortSignal
}): Promise<SessionFileDiscovery> {
  const files = new SessionNewestFiles(args.limit)
  const selectedFiles: FileWithMtime[] = []
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
          selectedFiles.length === 0 &&
          isSelectedSessionFile(
            args.selectedSessionId,
            args.agent,
            observation.file.path,
            args.executionHostId
          )
        ) {
          selectedFiles.push({ ...observation.file, modifiedAt: modifiedAt.toISOString() })
        }
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
  return {
    agent: args.agent,
    rootDir: args.rootDir,
    files: files.newest(),
    scopeFiles,
    selectedFiles
  }
}

export type SessionFileWalkOptions = {
  extensions: Set<string>
  filePredicate?: (path: string) => boolean
  // Return false to prune a subtree; depth 0 denotes a child of rootDir.
  directoryPredicate?: (name: string, depth: number) => boolean
  strictErrors?: boolean
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
    // Propagate gate refusal so stalled distros are not reported as empty trees.
    if (
      error instanceof WslTranscriptFsError ||
      (options.strictErrors && !isMissingSidecarError(error))
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
