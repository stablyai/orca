// Parcel debounce/teardown lock inversion can silently deadlock delivery across subscriptions.
// Probe a private directory; independent fs.watch distinguishes a child fault from an OS event stall.
import { type FSWatcher, mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as ParcelWatcher from '@parcel/watcher'
import { loadParcelWatcher } from './filesystem/watcher-process/parcel-watcher-module-loader'
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
// Even an apparent OS stall may hide a deadlock; bound it with a crash-fuse-limited restart.
export const CANARY_STALL_RESTART_AFTER_MS = 15 * 60_000
export const MAX_CRAWL_DURATION_MS = 60_000
export const CANARY_CPU_STORM_THRESHOLD = 0.85
export const CANARY_OVERFLOW_STORM_THRESHOLD = 20
export const CANARY_STORM_MAX_STRIKES = 6

export type WatcherCanaryActivity = {
  revision: number
  liveSubscriptions: number
  /** Start time of the in-flight native subscribe, or null when none is running. */
  pendingCrawlStartedAt: number | null
  /** Subscription ID of the in-flight crawl, if any. */
  activeCrawlSubscriptionId?: number | null
  /** Last time any native subscription callback fired in this process. */
  lastNativeCallbackAt: number
  /** Monotonic count of overflow events observed across subscriptions. */
  overflowCount?: number
  /** Subscription ID with the highest callback/overflow churn in the current window. */
  topSubscriptionId?: number | null
}

/** 'unknown': the canary disarmed (no live roots, or a crawl) after a stall. */
export type WatcherDeliveryHealth = 'healthy' | 'stalled' | 'unknown'

export type WatcherCanarySubscriptionFault = {
  kind: 'crawl-wedged' | 'storm'
  subscriptionId: number | null
}

/** Returns the revision a probe is valid for, or null when the canary is disarmed. */
export function armedCanaryRevision(
  activity: WatcherCanaryActivity,
  platform: NodeJS.Platform,
  now = Date.now()
): number | null {
  if (activity.pendingCrawlStartedAt !== null) {
    // macOS subscribe does not crawl; a crawl past the limit is wedged and must not stay disarmed.
    if (platform === 'darwin' || now - activity.pendingCrawlStartedAt > MAX_CRAWL_DURATION_MS) {
      return activity.revision
    }
    return null
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
  onHealthChange: (health: WatcherDeliveryHealth) => void = () => undefined,
  onSubscriptionFault: (fault: WatcherCanarySubscriptionFault) => void = () => undefined
): Promise<void> {
  const configuredCanaryDir = process.env.ORCA_WATCHER_CANARY_DIR
  let canaryDir: string
  let lastEventAt = 0
  try {
    canaryDir = configuredCanaryDir ?? mkdtempSync(join(tmpdir(), 'orca-watcher-canary-'))
    const watcher = await loadParcelWatcher()
    // Match the Windows subscriptions so the canary never probes for Watchman.
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

  // Keep one fs.watch: opening one per probe makes macOS rebuild the shared FSEventStream.
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
      // Any native callback proves the shared debounce thread is alive.
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

  let lastCpuUsage = process.cpuUsage()
  let lastCpuSampleAt = Date.now()
  let lastOverflowCount = 0
  let stormStrikes = 0

  const tick = async (): Promise<void> => {
    const currentActivity = getActivity()
    const sampledAt = Date.now()
    // A busy callback stream still counts as healthy, so a long crawl or a hot process has to stop itself.
    if (
      currentActivity.pendingCrawlStartedAt !== null &&
      process.platform !== 'darwin' &&
      sampledAt - currentActivity.pendingCrawlStartedAt > MAX_CRAWL_DURATION_MS
    ) {
      onSubscriptionFault({
        kind: 'crawl-wedged',
        subscriptionId: currentActivity.activeCrawlSubscriptionId ?? null
      })
      restart('subscription crawl timed out')
      return
    }
    const elapsedMs = sampledAt - lastCpuSampleAt
    const cpuDelta = process.cpuUsage(lastCpuUsage)
    const cpuRatio = elapsedMs > 0 ? (cpuDelta.user + cpuDelta.system) / (elapsedMs * 1_000) : 0
    const overflowCount = currentActivity.overflowCount ?? 0
    const overflowDelta = overflowCount - lastOverflowCount
    lastCpuUsage = process.cpuUsage()
    lastCpuSampleAt = sampledAt
    lastOverflowCount = overflowCount
    if (
      currentActivity.liveSubscriptions > 0 &&
      (cpuRatio >= CANARY_CPU_STORM_THRESHOLD || overflowDelta >= CANARY_OVERFLOW_STORM_THRESHOLD)
    ) {
      stormStrikes++
      if (stormStrikes >= CANARY_STORM_MAX_STRIKES) {
        onSubscriptionFault({
          kind: 'storm',
          subscriptionId: currentActivity.topSubscriptionId ?? null
        })
        restart('watcher resource storm detected')
        return
      }
    } else {
      stormStrikes = 0
    }

    const activityRevision = stableRevision()
    if (activityRevision === null) {
      misses = 0
      // Disarming invalidates stall evidence; stop host rescans until the canary can probe again.
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
    // A crawl starting after the write invalidates this probe; lifecycle work is not a delivery deadlock.
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
      // fs.watch must have delivered before it can distinguish OS stalls from child deadlock.
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
