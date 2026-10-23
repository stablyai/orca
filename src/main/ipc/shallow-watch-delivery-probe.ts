import { watch } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Why: fs.watch reports success and then delivers nothing on hosts where the
// platform notification path is broken — observed on a macOS 26.3.1 machine
// where both fs.watch and the native backend stayed silent for in-process
// writes, with no error on either. Shallow subscriptions have no other way to
// notice, so metadata would go stale until restart. Parcel already guards its
// own delivery with a canary; this is the same idea for the Node path.
const PROBE_TIMEOUT_MS = 2_000

// Why: a negative is re-measured after this, so one timeout during a noisy
// moment cannot fail every later shallow subscribe in the process.
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
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const watcher = watch(directory, { persistent: false }, () => resolve(true))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      watcher.on('error', () => resolve(false))
      // Deliberately not unref'd: this one-shot must resolve even if the child
      // has no other pending work at probe time.
      timer = setTimeout(() => resolve(false), timeoutMs)
      // Two writes: some backends coalesce the creation of the first entry.
      await writeFile(join(directory, 'probe'), '1')
      await writeFile(join(directory, 'probe'), '2')
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

/** Resolves false when this host accepts fs.watch registrations but never
 *  delivers events, so callers can fall back instead of going silently stale.
 *  A success is kept for the process; a failure is re-measured after a delay. */
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
