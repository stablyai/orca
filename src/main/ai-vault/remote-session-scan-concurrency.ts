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
  return {
    readDir: (dirPath) => gate(() => provider.readDir(dirPath)),
    readFile: (filePath) => gate(() => provider.readFile(filePath)),
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
