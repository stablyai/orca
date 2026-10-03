import { lstat, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { WebContents } from 'electron'
import type { FileUploadSession, IFilesystemProvider } from '../providers/types'
import type { ImportItemResult } from '../../shared/filesystem-import-result-types'
import {
  RUNTIME_UPLOAD_PROGRESS_CHANNEL,
  throttleRuntimeUploadProgress,
  type RuntimeUploadProgress
} from './runtime-upload-progress'
import { registerCancellableUpload, scopeRuntimeUploadId } from './runtime-upload-cancellation'
import {
  describeUploadCancelledWithLeftovers as describeCancelledImport,
  withUploadLeftovers
} from '../../shared/ssh-import-cancel-reason'
import {
  type CreatedRemoteEntry,
  SshImportCreatedLedger,
  createLedgerTrackedProvider
} from './filesystem-import-ssh-rollback'

export type SshImportProgressTarget = {
  sender: Pick<WebContents, 'id' | 'isDestroyed' | 'send'>
  /** Renderer-minted id per dropped source; it keys progress events and cancellation. */
  uploadIdsBySourcePath: Record<string, string>
}

/** Reads the sender only when ids were sent, so callers without progress pass no event. */
export function toSshImportProgressTarget(
  event: { sender: SshImportProgressTarget['sender'] } | null | undefined,
  uploadIds: unknown
): SshImportProgressTarget | undefined {
  if (!event || !uploadIds || typeof uploadIds !== 'object') {
    return undefined
  }
  const uploadIdsBySourcePath: Record<string, string> = {}
  for (const [sourcePath, uploadId] of Object.entries(uploadIds)) {
    if (typeof uploadId === 'string' && uploadId !== '') {
      uploadIdsBySourcePath[sourcePath] = uploadId
    }
  }
  return { sender: event.sender, uploadIdsBySourcePath }
}

export type SshImportCancellations = {
  signalFor: (sourcePath: string) => AbortSignal | undefined
  release: () => void
}

/**
 * Registers every dropped source's cancel handle when the IPC starts and releases
 * them when it returns, so a click on a row that has not started yet is never lost
 * and nothing depends on the renderer to clean up.
 */
export function registerSshImportCancellations(
  target: SshImportProgressTarget | undefined
): SshImportCancellations {
  const registrations = new Map<string, ReturnType<typeof registerCancellableUpload>>()
  const senderId = target?.sender.id
  for (const [sourcePath, uploadId] of Object.entries(target?.uploadIdsBySourcePath ?? {})) {
    if (senderId !== undefined) {
      registrations.set(
        sourcePath,
        registerCancellableUpload(scopeRuntimeUploadId(senderId, uploadId))
      )
    }
  }
  return {
    signalFor: (sourcePath) => registrations.get(sourcePath)?.signal,
    release: () => {
      for (const registration of registrations.values()) {
        registration.release()
      }
    }
  }
}

export type LocalUploadMeasure = { kind: 'file' | 'directory' | null; bytes: number }

/**
 * Bytes the SSH upload will move. Display-only, so an unreadable subtree is skipped
 * rather than failing the whole measure and leaving the row stuck at zero.
 */
export async function measureLocalUpload(
  path: string,
  signal?: AbortSignal
): Promise<LocalUploadMeasure> {
  let root: Awaited<ReturnType<typeof lstat>>
  try {
    root = await lstat(path)
  } catch {
    return { kind: null, bytes: 0 }
  }
  if (root.isFile()) {
    return { kind: 'file', bytes: root.size }
  }
  if (!root.isDirectory()) {
    return { kind: null, bytes: 0 }
  }
  return { kind: 'directory', bytes: await measureLocalDirectory(path, signal) }
}

async function measureLocalDirectory(dirPath: string, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted()
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => [])
  let total = 0
  for (const entry of entries) {
    const childPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      total += await measureLocalDirectory(childPath, signal)
    } else if (entry.isFile()) {
      total += await lstat(childPath).then(
        (stat) => stat.size,
        () => 0
      )
    }
  }
  return total
}

/**
 * Runs one dropped source's SSH import with the same progress events and cancel
 * handle the runtime upload panel uses, so both transports share one UI.
 */
export async function importSshSourceWithProgress(
  target: SshImportProgressTarget | undefined,
  cancellations: SshImportCancellations,
  sourcePath: string,
  provider: IFilesystemProvider,
  uploadSession: FileUploadSession,
  assertCurrent: (() => void) | undefined,
  run: (
    session: FileUploadSession,
    provider: IFilesystemProvider,
    onFailure?: () => void
  ) => Promise<ImportItemResult>
): Promise<ImportItemResult> {
  const uploadId = target?.uploadIdsBySourcePath[sourcePath]
  const signal = cancellations.signalFor(sourcePath)
  if (!target || !uploadId || !signal) {
    return run(uploadSession, provider)
  }
  const { sender } = target
  const send = (progress: RuntimeUploadProgress): void => {
    if (!sender.isDestroyed()) {
      sender.send(RUNTIME_UPLOAD_PROGRESS_CHANNEL, progress)
    }
  }
  const emit = throttleRuntimeUploadProgress(send)
  let measure: LocalUploadMeasure
  try {
    measure = await measureLocalUpload(resolve(sourcePath), signal)
  } catch (error) {
    if (signal.aborted) {
      return { sourcePath, status: 'failed', reason: describeCancelledImport([]), cancelled: true }
    }
    throw error
  }
  const { bytes: totalBytes, kind } = measure
  const report = (sentBytes: number): void =>
    emit({ uploadId, sentBytes, totalBytes, ...(kind ? { kind } : {}) })
  // Why: 100% must mean the remote closed every file and the import settled, so a
  // cancel can never roll back something the user already saw finish.
  const inFlightCap = totalBytes > 0 ? totalBytes - 1 : Number.POSITIVE_INFINITY
  let sentBytes = 0
  report(0)

  const ledger = new SshImportCreatedLedger(provider, uploadSession, assertCurrent)
  // Why: a cancel clicked while a real failure is already unwinding must not relabel it.
  let failedBeforeCancel = false
  const trackedSession: FileUploadSession = {
    uploadFile: async (localPath, remotePath, options) => {
      signal.throwIfAborted()
      const sourceBytes = await lstat(localPath).then(
        (stat) => stat.size,
        () => Number.POSITIVE_INFINITY
      )
      let fileSentBytes = 0
      let created: CreatedRemoteEntry | undefined
      // Why: a cancel mid-file leaves only what was sent; bounding by it keeps an append by
      // another client from passing as ours.
      const bound = (): number => Math.min(sourceBytes, fileSentBytes)
      await uploadSession.uploadFile(localPath, remotePath, {
        ...options,
        signal,
        // Why: only the exclusive open proves the file is ours; an EEXIST loser records nothing.
        onRemoteCreated: () => {
          created = ledger.record(remotePath, 'file', bound())
        },
        onBytesTransferred: (bytes) => {
          fileSentBytes += bytes
          if (created) {
            created.maxBytes = bound()
          }
          sentBytes += bytes
          report(Math.min(sentBytes, inFlightCap))
        }
      })
    },
    // Why: the shared session outlives this source; its owner closes it once.
    close: () => {}
  }

  const result = await run(trackedSession, createLedgerTrackedProvider(provider, ledger), () => {
    failedBeforeCancel ||= !signal.aborted
  })
  if (signal.aborted) {
    // Why: covers a cancel after the last byte and an empty folder, which raise nothing.
    await ledger.rollback()
    if (result.status === 'failed' && failedBeforeCancel) {
      return { ...result, reason: withUploadLeftovers(result.reason, ledger.remaining) }
    }
    return {
      sourcePath,
      status: 'failed',
      reason: describeCancelledImport(ledger.remaining),
      cancelled: true
    }
  }
  if (result.status === 'failed' && ledger.remaining.length > 0) {
    // Why: a failure that is not a cancel keeps what it could not (or, on a dropped connection,
    // did not try to) roll back, and the user must be told the partial is there.
    return { ...result, reason: withUploadLeftovers(result.reason, ledger.remaining) }
  }
  if (result.status === 'imported') {
    // Why: the settled total bypasses the throttle, which may be holding the last slice back.
    send({
      uploadId,
      sentBytes: Math.max(sentBytes, totalBytes),
      totalBytes,
      ...(kind ? { kind } : {})
    })
  }
  return result
}
