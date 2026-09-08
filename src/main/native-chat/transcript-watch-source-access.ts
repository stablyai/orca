import { createRunningGuardedTranscriptNativeWatcher } from './wsl-transcript-watcher-running-guard'
import { observeWslTranscriptRunningState } from './wsl-transcript-running-observer'
import { createTranscriptWatchScheduler } from './transcript-watch-scheduler'
import { readTranscriptBoundaryFingerprint } from './transcript-boundary-fingerprint'
import type { TranscriptFileSource } from './transcript-file-source'
import type { NativeChatLineDecoder } from './transcript-tail-reader'
import { readNativeChatTranscriptTailFile } from './transcript-tail-reader'
import type { NativeChatTranscriptSubscription } from './transcript-watch-contract'
import { trackActiveNativeChatWatcher } from './transcript-watcher-count'
import {
  boundaryFingerprint,
  readTranscriptFileVersion,
  transcriptFileVersionChanged,
  type TranscriptFileVersion
} from './transcript-file-version'
import { wslGatedStat } from './wsl-transcript-fs-access'

export async function probeTranscriptWatchFile(
  filePath: string,
  fileSource: TranscriptFileSource | undefined,
  signal?: AbortSignal
): Promise<void> {
  await (fileSource ? fileSource.stat(filePath) : wslGatedStat(filePath, 'exact', signal))
  signal?.throwIfAborted()
}

export async function readTranscriptWatchFileVersion(
  filePath: string,
  fileSource: TranscriptFileSource | undefined,
  signal: AbortSignal
): Promise<TranscriptFileVersion> {
  const version = fileSource
    ? await fileSource.stat(filePath)
    : await readTranscriptFileVersion(filePath, signal)
  signal.throwIfAborted()
  return version
}

export async function readTranscriptWatchBoundary(
  filePath: string,
  offset: number,
  fileSource: TranscriptFileSource | undefined,
  signal: AbortSignal
): Promise<string> {
  const fingerprint = fileSource
    ? await readTranscriptBoundaryFingerprint(filePath, offset, fileSource)
    : await boundaryFingerprint(filePath, offset, signal)
  signal.throwIfAborted()
  return fingerprint
}

export async function readTranscriptWatchState(
  filePath: string,
  offset: number,
  fileSource: TranscriptFileSource | undefined,
  signal: AbortSignal
): Promise<{ version: TranscriptFileVersion; boundary: string }> {
  const version = await readTranscriptWatchFileVersion(filePath, fileSource, signal)
  const boundary = await readTranscriptWatchBoundary(filePath, offset, fileSource, signal)
  return { version, boundary }
}

export function readTranscriptWatchTail(
  filePath: string,
  limit: number,
  decode: NativeChatLineDecoder,
  decodeLifecycle: Parameters<typeof readNativeChatTranscriptTailFile>[5],
  fileSource: TranscriptFileSource | undefined,
  signal: AbortSignal
) {
  return readNativeChatTranscriptTailFile(
    filePath,
    limit,
    decode,
    false,
    undefined,
    decodeLifecycle,
    fileSource,
    signal
  )
}

export function createSourceAwareTranscriptNativeWatcher(
  filePath: string,
  fileSource: TranscriptFileSource | undefined,
  onEvent: () => void,
  onRetry: () => void
) {
  return !fileSource || fileSource.supportsNativeWatch
    ? createRunningGuardedTranscriptNativeWatcher(filePath, onEvent, onRetry)
    : {
        bind: () => false,
        invalidate: () => {},
        needsRebind: () => false,
        dispose: () => {}
      }
}

export function activateTranscriptWatchRuntime(
  isWslPath: boolean,
  scheduler: ReturnType<typeof createTranscriptWatchScheduler>,
  nativeWatcher: ReturnType<typeof createSourceAwareTranscriptNativeWatcher>
): void {
  nativeWatcher.bind()
  if (!isWslPath) {
    scheduler.startReconciliation()
  }
  trackActiveNativeChatWatcher(1)
  scheduler.scheduleEventDrain()
}

export function disposeTranscriptWatchRuntime(
  scheduler: ReturnType<typeof createTranscriptWatchScheduler>,
  stopObservation: () => void,
  nativeWatcher: ReturnType<typeof createSourceAwareTranscriptNativeWatcher>
): void {
  scheduler.dispose()
  stopObservation()
  nativeWatcher.dispose()
  trackActiveNativeChatWatcher(-1)
}

export function observeTranscriptWatchRunningState(
  filePath: string,
  isWslPath: boolean,
  reconcile: () => Promise<void>,
  nativeWatcher: ReturnType<typeof createSourceAwareTranscriptNativeWatcher>
): () => void {
  return isWslPath
    ? observeWslTranscriptRunningState(filePath, reconcile, () => nativeWatcher.invalidate())
    : () => {}
}

export function createTranscriptWatchSubscription(
  unsubscribe: () => void
): NativeChatTranscriptSubscription {
  return { watching: true, unsubscribe }
}

export function createTranscriptWatchReconciler(args: {
  isClosed: () => boolean
  readVersion: () => Promise<TranscriptFileVersion>
  watchedVersion: () => TranscriptFileVersion | null
  offset: () => number
  needsRebind: () => boolean
  drain: () => Promise<void>
  isWslPath: boolean
}): () => Promise<void> {
  return async () => {
    if (args.isClosed()) {
      return
    }
    try {
      const current = await args.readVersion()
      if (args.isClosed()) {
        return
      }
      const versionChanged =
        args.watchedVersion() === null ||
        transcriptFileVersionChanged(current, args.watchedVersion() as TranscriptFileVersion)
      if (versionChanged || current.size !== args.offset() || args.needsRebind()) {
        await args.drain()
      }
    } catch {
      await (args.isWslPath ? undefined : args.drain())
    }
  }
}

export function createTranscriptWatchSchedulerForTranscript(
  debounceMs: number | undefined,
  reconciliationIntervalMs: number | undefined,
  drain: () => void,
  reconcile: () => Promise<void>
) {
  return createTranscriptWatchScheduler({ debounceMs, reconciliationIntervalMs, drain, reconcile })
}
