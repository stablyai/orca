import { watch } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Broken notification backends can accept fs.watch yet stay silent; probe delivery before trusting shallow watches.
const PROBE_TIMEOUT_MS = 2_000

// Retry negative probes so a transient timeout cannot disable all later shallow subscriptions.
const NEGATIVE_RECHECK_MS = 30_000

let delivered = false
let probe: Promise<boolean> | null = null
let negativeAt: number | null = null

/** Records that fs.watch delivered at least once in this process. */
export function noteShallowWatchDelivered(): void {
  delivered = true
}

export function hasShallowWatchDelivered(): boolean {
  return delivered
}

export async function measureShallowWatchDelivery(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  let directory: string | null = null
  try {
    directory = await mkdtemp(join(tmpdir(), 'orca-shallow-probe-'))
    const probePath = join(directory, 'probe')
    // macOS shallow subscriptions watch files (kqueue), not directories (FSEvents),
    // so probe the same notification path they depend on.
    const watchesFiles = process.platform === 'darwin'
    if (watchesFiles) {
      await writeFile(probePath, '0')
    }
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const watcher = watch(watchesFiles ? probePath : directory, { persistent: false }, () =>
      resolve(true)
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      watcher.on('error', () => resolve(false))
      // Keep the one-shot alive even when no other work remains in the process.
      timer = setTimeout(() => resolve(false), timeoutMs)
      // Two writes: some backends coalesce the creation of the first entry.
      await writeFile(probePath, '1')
      await writeFile(probePath, '2')
      return await promise
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      watcher.close()
    }
  } catch {
    return false
  } finally {
    if (directory) {
      await rm(directory, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** Cache successful delivery for this process; retry failures after a delay so silent watchers can fall back. */
export function detectShallowWatchDelivery(): Promise<boolean> {
  if (delivered) {
    return Promise.resolve(true)
  }
  if (negativeAt !== null && Date.now() - negativeAt < NEGATIVE_RECHECK_MS) {
    return Promise.resolve(false)
  }
  probe ??= measureShallowWatchDelivery().then((works) => {
    probe = null
    if (works) {
      delivered = true
    } else {
      negativeAt = Date.now()
    }
    return works
  })
  return probe
}

export function resetShallowWatchDeliveryProbeForTests(): void {
  delivered = false
  probe = null
  negativeAt = null
}
