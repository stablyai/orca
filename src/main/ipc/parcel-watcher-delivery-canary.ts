// Canary self-check for the watcher child. Why: @parcel/watcher can wedge
// silently — a lock-order inversion between Debounce::notify (debounce mutex →
// watcher mutex) and Watcher teardown (watcher mutex → debounce mutex in
// ~Watcher) deadlocks the single process-wide debounce thread, after which
// every subscription still acks but no events are ever delivered. The canary
// watches a private temp dir and touches a file in it; consecutive missed
// deliveries mean event delivery is dead, so exit and let the host respawn.
//
// A missed canary can also mean the OS event source itself is stalled (an
// overloaded macOS fseventsd delays every client). A restart cannot fix that
// and recreating every stream adds load, so before exiting the canary checks
// whether an independent fs.watch on the same dir also stays silent, and
// reports the stall to the host so callers can rescan instead of going stale.
import { type FSWatcher, mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as ParcelWatcher from '@parcel/watcher'
import { loadParcelWatcher } from './parcel-watcher-module-loader'
import { hasShallowWatchDelivered, noteShallowWatchDelivered } from './shallow-watch-delivery-probe'
import { errorMessage } from '../../shared/error-message'

const CANARY_INTERVAL_MS = 10_000
const CANARY_EVENT_TIMEOUT_MS = 5_000
const CANARY_MAX_MISSES = 2
const CANARY_NEXT_PROBE_DELAY_MS = CANARY_INTERVAL_MS - CANARY_EVENT_TIMEOUT_MS
const INDEPENDENT_PROBE_WINDOW_MS = 5_000
const INDEPENDENT_PROBE_WRITE_INTERVAL_MS = 1_000
export const CANARY_STALL_BACKOFF_INITIAL_MS = 30_000
export const CANARY_STALL_BACKOFF_MAX_MS = 5 * 60_000
// Why: a deadlock can look like a stall (e.g. fs.watch muted by the same
// fault); bound it with a restart that the host's crash fuse still rate-limits.
export const CANARY_STALL_RESTART_AFTER_MS = 15 * 60_000

export type WatcherCanaryActivity = {
  revision: number
  liveSubscriptions: number
  /** Start time of the in-flight native subscribe, or null when none is running. */
  pendingCrawlStartedAt: number | null
  /** Last time any native subscription callback fired in this process. */
  lastNativeCallbackAt: number
}

/** 'unknown': the canary disarmed (no live roots, or a crawl) after a stall. */
export type WatcherDeliveryHealth = 'healthy' | 'stalled' | 'unknown'

/** Returns the revision a probe is valid for, or null when the canary is disarmed. */
export function armedCanaryRevision(
  activity: WatcherCanaryActivity,
  platform: NodeJS.Platform
): number | null {
  if (activity.pendingCrawlStartedAt !== null) {
    // Why: FSEvents subscribe does not crawl, so a pending subscribe there is
    // most likely stuck behind the deadlock the canary exists to catch. Crawls
    // elsewhere (huge or network trees) hold Parcel's backend mutex for as long
    // as they take, and a restart would only re-crawl from scratch.
    return platform === 'darwin' ? activity.revision : null
  }
  return activity.liveSubscriptions > 0 ? activity.revision : null
}

type IndependentProbeVerdict =
  | 'native-delivered'
  | 'independent-only'
  | 'silent'
  | 'unavailable'
  | 'inconclusive'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function startWatcherDeliveryCanary(
  getActivity: () => WatcherCanaryActivity,
  onHealthChange: (health: WatcherDeliveryHealth) => void = () => undefined
): Promise<void> {
  const configuredCanaryDir = process.env.ORCA_WATCHER_CANARY_DIR
  let canaryDir: string
  let lastEventAt = 0
  try {
    canaryDir = configuredCanaryDir ?? mkdtempSync(join(tmpdir(), 'orca-watcher-canary-'))
    const watcher = await loadParcelWatcher()
    // Why: pin the Windows backend like the main subscriptions do, so the
    // canary never probes for Watchman.
    const opts: ParcelWatcher.Options = process.platform === 'win32' ? { backend: 'windows' } : {}
    await watcher.subscribe(
      canaryDir,
      (err) => {
        if (!err) {
          lastEventAt = Date.now()
        }
      },
      opts
    )
  } catch (err) {
    process.stderr.write(`[parcel-watcher-process] canary unavailable: ${errorMessage(err)}\n`)
    return
  }
  process.on('exit', () => {
    if (configuredCanaryDir) {
      return
    }
    try {
      rmSync(canaryDir, { recursive: true, force: true })
    } catch {
      // Temp dir cleanup is best-effort.
    }
  })

  // One long-lived fs.watch on the canary dir: canary writes keep proving it
  // works, and a stall probe only checks whether it delivered since time T.
  // Why: opening one per probe makes macOS rebuild the shared FSEventStream.
  let independentLastEventAt = 0
  let independentWatch: FSWatcher | null = null
  const ensureIndependentWatch = (): boolean => {
    if (independentWatch) {
      return true
    }
    try {
      const created = watch(canaryDir, { persistent: false }, () => {
        independentLastEventAt = Date.now()
        noteShallowWatchDelivered()
      })
      created.on('error', () => {
        if (independentWatch === created) {
          independentWatch = null
        }
        try {
          created.close()
        } catch {
          // Already failed; close is best-effort.
        }
      })
      independentWatch = created
      return true
    } catch {
      return false
    }
  }
  ensureIndependentWatch()

  const nativeDeliveredSince = (time: number): boolean =>
    lastEventAt >= time || getActivity().lastNativeCallbackAt >= time

  const probeIndependentDelivery = async (): Promise<IndependentProbeVerdict> => {
    const startedAt = Date.now()
    if (!ensureIndependentWatch()) {
      return 'unavailable'
    }
    for (
      let elapsed = 0;
      elapsed < INDEPENDENT_PROBE_WINDOW_MS;
      elapsed += INDEPENDENT_PROBE_WRITE_INTERVAL_MS
    ) {
      try {
        // Repeated writes: FSEvents can coalesce or delay a single one.
        writeFileSync(join(canaryDir, 'canary-probe.txt'), String(Date.now()))
      } catch {
        return 'inconclusive'
      }
      await sleep(INDEPENDENT_PROBE_WRITE_INTERVAL_MS)
      // Why: any native callback (not just the canary's) proves the shared
      // debounce thread is alive, so the child is not deadlocked.
      if (nativeDeliveredSince(startedAt)) {
        return 'native-delivered'
      }
    }
    if (independentLastEventAt >= startedAt) {
      return 'independent-only'
    }
    return independentWatch ? 'silent' : 'unavailable'
  }

  let misses = 0
  let stallBackoffMs: number | null = null
  let stallStartedAt: number | null = null
  let health: WatcherDeliveryHealth | null = null
  const setHealth = (next: WatcherDeliveryHealth): void => {
    if (health !== next) {
      health = next
      onHealthChange(next)
    }
  }
  const stableRevision = (): number | null => armedCanaryRevision(getActivity(), process.platform)
  const nextProbeDelay = (): number => stallBackoffMs ?? CANARY_NEXT_PROBE_DELAY_MS
  const schedule = (delayMs: number): void => {
    setTimeout(() => void tick(), delayMs)
  }
  const markDelivered = (): void => {
    misses = 0
    if (stallBackoffMs !== null) {
      process.stderr.write('[parcel-watcher-process] system file events recovered after stall\n')
    }
    stallBackoffMs = null
    stallStartedAt = null
    setHealth('healthy')
  }
  const restart = (reason: string): void => {
    process.stderr.write(
      `[parcel-watcher-process] event delivery wedged (${reason}); restarting watcher process\n`
    )
    process.exit(2)
  }

  const tick = async (): Promise<void> => {
    const activityRevision = stableRevision()
    if (activityRevision === null) {
      misses = 0
      // Why: a disarmed canary cannot confirm a stall; end it so the host stops
      // rescanning, and re-detect it once re-armed.
      if (health === 'stalled') {
        stallBackoffMs = null
        stallStartedAt = null
        setHealth('unknown')
      }
      schedule(CANARY_INTERVAL_MS)
      return
    }
    const probedAt = Date.now()
    try {
      writeFileSync(join(canaryDir, 'canary.txt'), String(probedAt))
    } catch {
      schedule(nextProbeDelay())
      return
    }
    await sleep(CANARY_EVENT_TIMEOUT_MS)
    // A root may start crawling after this probe was written. Invalidate the
    // probe instead of misclassifying lifecycle work as a delivery deadlock.
    if (stableRevision() !== activityRevision) {
      misses = 0
      schedule(nextProbeDelay())
      return
    }
    if (lastEventAt >= probedAt) {
      markDelivered()
      schedule(CANARY_NEXT_PROBE_DELAY_MS)
      return
    }
    misses++
    if (misses < CANARY_MAX_MISSES) {
      schedule(nextProbeDelay())
      return
    }
    const verdict = await probeIndependentDelivery()
    if (stableRevision() !== activityRevision) {
      misses = 0
      schedule(nextProbeDelay())
      return
    }
    if (verdict === 'native-delivered') {
      markDelivered()
      schedule(CANARY_NEXT_PROBE_DELAY_MS)
      return
    }
    if (verdict === 'independent-only') {
      restart('canary starved while fs.watch delivered')
      return
    }
    if (verdict === 'unavailable') {
      restart('canary starved; fs.watch probe unavailable')
      return
    }
    if (verdict === 'silent') {
      // Why: a host where fs.watch never delivered cannot tell a stall from a
      // deadlock; any earlier delivery in this process proves it can.
      if (!hasShallowWatchDelivered()) {
        restart('canary starved; fs.watch never delivered in this process')
        return
      }
      const now = Date.now()
      stallStartedAt ??= now
      if (now - stallStartedAt >= CANARY_STALL_RESTART_AFTER_MS) {
        restart(`system file events stalled for ${Math.round((now - stallStartedAt) / 60_000)} min`)
        return
      }
      stallBackoffMs =
        stallBackoffMs === null
          ? CANARY_STALL_BACKOFF_INITIAL_MS
          : Math.min(stallBackoffMs * 2, CANARY_STALL_BACKOFF_MAX_MS)
      setHealth('stalled')
      process.stderr.write(
        `[parcel-watcher-process] system file events stalled (canary and fs.watch probe both silent); keeping watcher process, next check in ${stallBackoffMs / 1000}s\n`
      )
    }
    schedule(nextProbeDelay())
  }

  schedule(CANARY_INTERVAL_MS)
}
