import type { AppUpdatePreferences, KnownAppUpdate } from '../storage/app-update-preferences'
import { EMPTY_APP_UPDATE_PREFERENCES } from '../storage/app-update-preferences'
import type { AppUpdateSource } from './app-update-source'
import { isNewerReleaseVersion } from './app-update-source'

// Same cadence as the desktop updater (src/main/updater-events.ts).
export const APP_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const APP_UPDATE_RETRY_INTERVAL_MS = 60 * 60 * 1000
export const APP_UPDATE_CHECK_TIMEOUT_MS = 8000

type TimerHandle = ReturnType<typeof setTimeout>

export type AppUpdateCheckOutcome = 'available' | 'up-to-date' | 'failed'

export type AppUpdateState = {
  readonly lastCheckedAt: number | null
  /** Newer than the installed binary; recomputed from `latest`, so installing it clears this. */
  readonly available: KnownAppUpdate | null
  readonly dismissedVersion: string | null
  readonly checking: boolean
}

/** The update home should offer: dismissal hides only the version that was dismissed. */
export function undismissedAppUpdate(state: AppUpdateState): KnownAppUpdate | null {
  return state.available && state.available.version !== state.dismissedVersion
    ? state.available
    : null
}

export type AppUpdateCheckerDeps = {
  source: AppUpdateSource | null
  installedVersion: string | null
  now: () => number
  setTimer: (run: () => void, delayMs: number) => TimerHandle
  clearTimer: (handle: TimerHandle) => void
  subscribeForeground: (onForeground: () => void) => () => void
  loadPreferences: () => Promise<AppUpdatePreferences>
  saveCheck: (checkedAt: number, latest: KnownAppUpdate | null) => Promise<void>
  saveDismissedVersion: (version: string) => Promise<void>
}

export type AppUpdateChecker = ReturnType<typeof createAppUpdateChecker>

export function createAppUpdateChecker(deps: AppUpdateCheckerDeps) {
  let prefs = EMPTY_APP_UPDATE_PREFERENCES
  let checking = false
  let inFlight: Promise<AppUpdateCheckOutcome> | null = null
  // Nothing is due until the stored last check has been read.
  let nextDueAt = Number.POSITIVE_INFINITY
  let timer: TimerHandle | null = null
  let started = false
  let snapshot = buildSnapshot()
  const listeners = new Set<() => void>()

  function buildSnapshot(): AppUpdateState {
    const latest = prefs.latest
    const available =
      latest &&
      deps.installedVersion &&
      isNewerReleaseVersion(latest.version, deps.installedVersion)
        ? latest
        : null
    return {
      lastCheckedAt: prefs.lastCheckedAt,
      available,
      dismissedVersion: prefs.dismissedVersion,
      checking
    }
  }

  function publish(): void {
    snapshot = buildSnapshot()
    for (const listener of listeners) {
      listener()
    }
  }

  function schedule(dueAt: number): void {
    nextDueAt = dueAt
    if (timer !== null) {
      deps.clearTimer(timer)
      timer = null
    }
    if (started) {
      timer = deps.setTimer(
        () => {
          timer = null
          runIfDue()
        },
        Math.max(0, dueAt - deps.now())
      )
    }
  }

  function runIfDue(): void {
    if (started && inFlight === null && deps.now() >= nextDueAt) {
      void checkNow()
    }
  }

  async function runCheck(source: AppUpdateSource, installed: string) {
    checking = true
    publish()
    const controller = new AbortController()
    // Why race: the bound holds even for a request that does not honour the signal.
    const timedOut = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('update check timed out')))
    })
    const timeout = deps.setTimer(() => controller.abort(), APP_UPDATE_CHECK_TIMEOUT_MS)
    try {
      const result = await Promise.race([source.check(installed, controller.signal), timedOut])
      const checkedAt = deps.now()
      const latest =
        result.kind === 'available' ? { version: result.version, url: result.url } : null
      prefs = { ...prefs, lastCheckedAt: checkedAt, latest }
      schedule(checkedAt + APP_UPDATE_CHECK_INTERVAL_MS)
      await deps.saveCheck(checkedAt, latest).catch(() => {})
      return result.kind === 'available' ? 'available' : 'up-to-date'
    } catch {
      schedule(deps.now() + APP_UPDATE_RETRY_INTERVAL_MS)
      return 'failed'
    } finally {
      deps.clearTimer(timeout)
      checking = false
      publish()
    }
  }

  /** Runs now whatever the cadence says; joins a check already in flight. */
  function checkNow(): Promise<AppUpdateCheckOutcome> {
    const { source, installedVersion } = deps
    if (!source || !installedVersion) {
      return Promise.resolve('failed')
    }
    inFlight ??= runCheck(source, installedVersion).finally(() => {
      inFlight = null
    })
    return inFlight
  }

  /** Cold start: loads what the last run saw, then checks only if the cadence says it is due. */
  function start(): () => void {
    started = true
    const unsubscribe = deps.subscribeForeground(runIfDue)
    void deps.loadPreferences().then((loaded) => {
      if (!started) {
        return
      }
      // A check or dismissal that landed while the store was read is newer than what it holds.
      const checkedMeanwhile = prefs.lastCheckedAt !== null
      prefs = {
        lastCheckedAt: checkedMeanwhile ? prefs.lastCheckedAt : loaded.lastCheckedAt,
        latest: checkedMeanwhile ? prefs.latest : loaded.latest,
        dismissedVersion: prefs.dismissedVersion ?? loaded.dismissedVersion
      }
      publish()
      if (!checkedMeanwhile) {
        schedule(
          loaded.lastCheckedAt === null ? 0 : loaded.lastCheckedAt + APP_UPDATE_CHECK_INTERVAL_MS
        )
      }
    })
    return () => {
      started = false
      unsubscribe()
      if (timer !== null) {
        deps.clearTimer(timer)
        timer = null
      }
    }
  }

  function dismiss(version: string): void {
    prefs = { ...prefs, dismissedVersion: version }
    publish()
    void deps.saveDismissedVersion(version).catch(() => {})
  }

  return {
    start,
    checkNow,
    dismiss,
    getSnapshot: (): AppUpdateState => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
