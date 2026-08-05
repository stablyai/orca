import type { RemoteSessionFilesystemProvider } from './remote-session-scanner-types'

// Why: discovery batches (8 sources) each stat in batches of 8, and parse
// batches read whole transcripts — nested fan-out put ~64 filesystem round
// trips on one SSH mux or relay event loop at once, blowing the scan budget and
// starving pty/fs/hook traffic. Every scan shares one in-flight ceiling.
const REMOTE_SCAN_FILESYSTEM_CONCURRENCY = 8

/** Wraps a provider so all of one scan's filesystem calls share a single
 * in-flight ceiling, regardless of how the callers nest their batches. */
export function limitRemoteScanFilesystemConcurrency(
  provider: RemoteSessionFilesystemProvider,
  maxInFlight: number = REMOTE_SCAN_FILESYSTEM_CONCURRENCY
): RemoteSessionFilesystemProvider {
  const gate = createConcurrencyGate(maxInFlight)
  const scanCursorSidecars = provider.scanCursorSidecars?.bind(provider)
  return {
    readDir: (dirPath) => gate(() => provider.readDir(dirPath)),
    readFile: (filePath) => gate(() => provider.readFile(filePath)),
    ...(scanCursorSidecars
      ? {
          scanCursorSidecars: (request, options) =>
            gate(() => scanCursorSidecars(request, options))
        }
      : {}),
    stat: (filePath) => gate(() => provider.stat(filePath))
  }
}

function createConcurrencyGate(maxInFlight: number): <T>(run: () => Promise<T>) => Promise<T> {
  const limit = Math.max(1, Math.floor(maxInFlight))
  const waiting: (() => void)[] = []
  let inFlight = 0

  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (inFlight < limit) {
      inFlight++
    } else {
      // The releasing call hands its slot over directly, so a queued caller can
      // never race a fresh one into an over-limit slot.
      await new Promise<void>((resolve) => waiting.push(resolve))
    }
    try {
      return await run()
    } finally {
      const next = waiting.shift()
      if (next) {
        next()
      } else {
        inFlight--
      }
    }
  }
}

export const AI_VAULT_DIRECT_SSH_SCAN_CONCURRENCY = 4

export async function mapDirectSshScans<T, U>(
  items: readonly T[],
  mapper: (item: T, signal: AbortSignal) => Promise<U>,
  signal: AbortSignal
): Promise<U[]> {
  const results: U[] = []
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      throwIfAborted(signal)
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index], signal)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(AI_VAULT_DIRECT_SSH_SCAN_CONCURRENCY, items.length) }, () =>
      worker()
    )
  )
  return results
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('ai_vault_scan_cancelled')
  }
}
