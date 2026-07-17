import { createHash } from 'node:crypto'

import type { SshRelayRuntimeScannedSourceTree } from './ssh-relay-runtime-source-scan'
import {
  assertSshRelayRuntimeOpenedFileSnapshot,
  assertSshRelayRuntimeSourcePathSnapshot,
  assertSshRelayRuntimeSourceTreeSnapshot,
  SSH_RELAY_RUNTIME_SOURCE_STREAM_OPERATIONS,
  sshRelayRuntimeSourceParentDirectories,
  type SshRelayRuntimeScannedSourceFile,
  type SshRelayRuntimeSourceFileHandle,
  type SshRelayRuntimeSourceStreamOperations
} from './ssh-relay-runtime-source-snapshot'

export type {
  SshRelayRuntimeScannedSourceFile,
  SshRelayRuntimeSourceStreamOperations
} from './ssh-relay-runtime-source-snapshot'

const CHUNK_BYTES = 64 * 1024
const MAXIMUM_CONCURRENT_FILES = 4
const MEASUREMENT_TIMEOUT_MS = 20 * 60_000
const MAXIMUM_INCREMENTAL_MEMORY_BYTES = 80 * 1024 * 1024

export type SshRelayRuntimeSourceDestination = Readonly<{
  write: (chunk: Buffer) => Promise<void>
  close: () => Promise<void>
  abort: (reason: unknown) => Promise<void>
}>

export type SshRelayRuntimeSourceStreamProgress = Readonly<{
  tupleId: SshRelayRuntimeScannedSourceTree['tupleId']
  contentId: SshRelayRuntimeScannedSourceTree['contentId']
  filesCompleted: number
  totalFiles: number
  bytesTransferred: number
  totalBytes: number
  activeFiles: number
}>

export type SshRelayRuntimeSourceStreamResult = Readonly<
  Omit<SshRelayRuntimeSourceStreamProgress, 'activeFiles'>
>

export type SshRelayRuntimeSourceStreamOptions = Readonly<{
  tree: SshRelayRuntimeScannedSourceTree
  signal: AbortSignal
  maximumConcurrency?: number
  openDestination: (
    file: SshRelayRuntimeScannedSourceFile,
    signal: AbortSignal
  ) => Promise<SshRelayRuntimeSourceDestination>
  onProgress?: (progress: SshRelayRuntimeSourceStreamProgress) => void
}>

function joinedFailure(primary: unknown, cleanup: readonly unknown[]): unknown {
  return cleanup.length === 0
    ? primary
    : new AggregateError([primary, ...cleanup], 'SSH relay runtime source stream cleanup failed')
}

function assertSourceDestination(
  destination: unknown
): asserts destination is SshRelayRuntimeSourceDestination {
  if (
    typeof destination !== 'object' ||
    destination === null ||
    !('write' in destination) ||
    typeof destination.write !== 'function' ||
    !('close' in destination) ||
    typeof destination.close !== 'function' ||
    !('abort' in destination) ||
    typeof destination.abort !== 'function'
  ) {
    throw new Error('SSH relay runtime source stream destination is incomplete')
  }
}

export async function streamSshRelayRuntimeSourceTree(
  options: SshRelayRuntimeSourceStreamOptions,
  overrides: Partial<SshRelayRuntimeSourceStreamOperations> = {}
): Promise<SshRelayRuntimeSourceStreamResult> {
  const { tree, signal, openDestination, onProgress } = options
  const maximumConcurrency = options.maximumConcurrency ?? 1
  if (
    !Number.isInteger(maximumConcurrency) ||
    maximumConcurrency < 1 ||
    maximumConcurrency > MAXIMUM_CONCURRENT_FILES
  ) {
    throw new Error(
      `SSH relay runtime source stream concurrency must be between 1 and ${MAXIMUM_CONCURRENT_FILES}`
    )
  }
  const operations = { ...SSH_RELAY_RUNTIME_SOURCE_STREAM_OPERATIONS, ...overrides }
  signal.throwIfAborted()
  await tree.assertLeaseOwned()
  await assertSshRelayRuntimeSourceTreeSnapshot(tree, signal, operations)

  let nextFileIndex = 0
  let filesCompleted = 0
  let bytesTransferred = 0
  let activeFiles = 0
  let stopReason: unknown
  const failures: unknown[] = []
  const seenDestinations = new WeakSet<object>()

  const emitProgress = (): void => {
    onProgress?.(
      Object.freeze({
        tupleId: tree.tupleId,
        contentId: tree.contentId,
        filesCompleted,
        totalFiles: tree.fileCount,
        bytesTransferred,
        totalBytes: tree.expandedBytes,
        activeFiles
      })
    )
  }

  const assertRunning = (): void => {
    signal.throwIfAborted()
    if (stopReason !== undefined) {
      throw stopReason
    }
  }

  const requestStop = (error: unknown): void => {
    if (stopReason === undefined) {
      stopReason = error
    }
  }

  const recordFailure = (error: unknown): void => {
    const isCleanupFailure =
      error instanceof AggregateError && error.errors.length > 0 && error.errors[0] === stopReason
    if (isCleanupFailure) {
      const unjoinedPrimaryIndex = failures.indexOf(stopReason)
      if (unjoinedPrimaryIndex >= 0) {
        failures.splice(unjoinedPrimaryIndex, 1)
      }
    } else if (
      error === stopReason &&
      failures.some(
        (failure) =>
          failure instanceof AggregateError &&
          failure.errors.length > 0 &&
          failure.errors[0] === stopReason
      )
    ) {
      return
    }
    if (!failures.includes(error)) {
      failures.push(error)
    }
  }

  const streamFile = async (
    file: SshRelayRuntimeScannedSourceFile,
    buffer: Buffer
  ): Promise<void> => {
    const parents = sshRelayRuntimeSourceParentDirectories(tree, file)
    let handle: SshRelayRuntimeSourceFileHandle | undefined
    let destination: SshRelayRuntimeSourceDestination | undefined
    let destinationActive = false
    try {
      assertRunning()
      await assertSshRelayRuntimeSourcePathSnapshot(tree, file, parents, signal, operations)
      assertRunning()
      handle = await operations.openFile(file.localPath)
      assertRunning()
      const opened = await handle.stat()
      assertSshRelayRuntimeOpenedFileSnapshot(file, opened, 'opening')

      assertRunning()
      const openedDestination: unknown = await openDestination(file, signal)
      assertSourceDestination(openedDestination)
      destination = openedDestination
      if (seenDestinations.has(destination)) {
        throw new Error('SSH relay runtime source stream destination was reused')
      }
      seenDestinations.add(destination)
      destinationActive = true
      activeFiles += 1

      const digest = createHash('sha256')
      let bytes = 0
      while (bytes < file.size) {
        assertRunning()
        const requested = Math.min(buffer.length, file.size - bytes)
        const { bytesRead } = await handle.read(buffer, 0, requested, bytes)
        if (bytesRead <= 0 || bytesRead > requested) {
          break
        }
        assertRunning()
        const chunk = buffer.subarray(0, bytesRead)
        // Why: the awaited destination write is the buffer-lifetime boundary; transports must not
        // retain the view after resolving, so the worker can reuse one bounded buffer.
        await destination.write(chunk)
        assertRunning()
        digest.update(chunk)
        bytes += bytesRead
        bytesTransferred += bytesRead
        emitProgress()
      }

      assertRunning()
      const afterRead = await handle.stat()
      assertSshRelayRuntimeOpenedFileSnapshot(file, afterRead, 'streaming')
      const closingHandle = handle
      handle = undefined
      await closingHandle.close()
      await assertSshRelayRuntimeSourcePathSnapshot(tree, file, parents, signal, operations)
      if (bytes !== file.size || `sha256:${digest.digest('hex')}` !== file.sha256) {
        throw new Error(`SSH relay runtime source file size or integrity changed: ${file.path}`)
      }

      assertRunning()
      await destination.close()
      destinationActive = false
      destination = undefined
      activeFiles -= 1
      filesCompleted += 1
      emitProgress()
    } catch (error) {
      // Why: peer workers must stop before potentially slow cleanup settles on the failing worker.
      requestStop(error)
      const cleanupFailures: unknown[] = []
      if (handle) {
        const closingHandle = handle
        handle = undefined
        await closingHandle.close().catch((closeError: unknown) => cleanupFailures.push(closeError))
      }
      if (destination && destinationActive) {
        destinationActive = false
        activeFiles -= 1
        await destination
          .abort(error)
          .catch((abortError: unknown) => cleanupFailures.push(abortError))
      }
      throw joinedFailure(error, cleanupFailures)
    }
  }

  const worker = async (): Promise<void> => {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
    while (stopReason === undefined) {
      signal.throwIfAborted()
      const index = nextFileIndex
      if (index >= tree.files.length) {
        return
      }
      nextFileIndex += 1
      try {
        await streamFile(tree.files[index], buffer)
      } catch (error) {
        recordFailure(error)
        return
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(maximumConcurrency, Math.max(1, tree.files.length)) },
    () => worker()
  )
  await Promise.allSettled(workers)
  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'SSH relay runtime source stream failed')
  }
  signal.throwIfAborted()
  await assertSshRelayRuntimeSourceTreeSnapshot(tree, signal, operations)
  signal.throwIfAborted()
  await tree.assertLeaseOwned()
  signal.throwIfAborted()

  if (filesCompleted !== tree.fileCount || bytesTransferred !== tree.expandedBytes) {
    throw new Error('SSH relay runtime source stream aggregate count or size is inconsistent')
  }
  return Object.freeze({
    tupleId: tree.tupleId,
    contentId: tree.contentId,
    filesCompleted,
    totalFiles: tree.fileCount,
    bytesTransferred,
    totalBytes: tree.expandedBytes
  })
}

export const SSH_RELAY_RUNTIME_SOURCE_STREAM_LIMITS = Object.freeze({
  chunkBytes: CHUNK_BYTES,
  maximumConcurrentFiles: MAXIMUM_CONCURRENT_FILES,
  measurementTimeoutMs: MEASUREMENT_TIMEOUT_MS,
  maximumIncrementalMemoryBytes: MAXIMUM_INCREMENTAL_MEMORY_BYTES
})
