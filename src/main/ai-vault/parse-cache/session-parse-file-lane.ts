import {
  abandonRemoteSessionScanOnCancel,
  throwIfAiVaultScanCancelled
} from '../scan-lifecycle/ai-vault-scan-cancellation'

const pending = new Map<string, Promise<unknown>>()

/** Serialize by path: overlapping reads corrupt shared message consumers and can rewind the cached cursor. */
export function inSessionParseFileLane<T>(
  path: string,
  parse: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const previous = pending.get(path)
  const acquired = Promise.resolve(previous).catch(() => undefined)
  const admission = abandonRemoteSessionScanOnCancel(acquired, signal)
  const run = (async () => {
    await acquired
    throwIfAiVaultScanCancelled(signal)
    return parse()
  })()
  pending.set(path, run)
  // Why: cancelling the caller must retain its chain link until the holder exits.
  void run
    .finally(() => {
      if (pending.get(path) === run) {
        pending.delete(path)
      }
    })
    .catch(() => undefined)
  // Why: an active parser must finish cancelling its consumers before its caller returns.
  return admission.then(() => run)
}
