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

let probe: Promise<boolean> | null = null

export async function measureShallowWatchDelivery(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  let directory: string | null = null
  try {
    directory = await mkdtemp(join(tmpdir(), 'orca-shallow-probe-'))
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const watcher = watch(directory, { persistent: false }, () => resolve(true))
    watcher.on('error', () => resolve(false))
    // Deliberately not unref'd: this one-shot must resolve even if the child
    // has no other pending work at probe time.
    const timer = setTimeout(() => resolve(false), timeoutMs)
    // Two writes: some backends coalesce the creation of the first entry.
    await writeFile(join(directory, 'probe'), '1')
    await writeFile(join(directory, 'probe'), '2')
    const delivered = await promise
    clearTimeout(timer)
    watcher.close()
    return delivered
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
 *  Measured once per process. */
export function detectShallowWatchDelivery(): Promise<boolean> {
  probe ??= measureShallowWatchDelivery()
  return probe
}

export function resetShallowWatchDeliveryProbeForTests(): void {
  probe = null
}
