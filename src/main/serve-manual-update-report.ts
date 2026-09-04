import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import type {
  RemoteServerUpdateInstallMode,
  ServeManualUpdateCheckState,
  ServeManualUpdateMethod,
  ServeManualUpdateReport
} from '../shared/remote-server-update'
import {
  getLinuxRootPackageType,
  isExternallyManagedLinuxInstall
} from './linux-update-package-type'
import {
  fetchNewerReleaseTagsWithReadiness,
  getReleaseTagUrl,
  normalizeTagToVersion
} from './updater-prerelease-feed'
import { isPrereleaseVersion } from './updater-fallback'
import { recordUpdaterLifecycle } from './updater-lifecycle-diagnostics'
import { AUTO_UPDATE_CHECK_INTERVAL_MS } from './updater/updater-state'
import { buildServeManualUpdateSteps, getServeUpgradeDocUrl } from './serve-manual-update-steps'

/**
 * Opts a host out of the daily release check. Named for exactly what it disables: an air-gapped or
 * egress-audited server makes no outbound call, and `check: 'disabled'` says so rather than
 * masquerading as a check that failed.
 */
export const SERVE_DISABLE_UPDATE_CHECK_ENV = 'ORCA_SERVE_DISABLE_UPDATE_CHECK'

type ReportState = {
  method: ServeManualUpdateMethod
  appImagePath: string | null
  check: ServeManualUpdateCheckState
  latestVersion: string | null
  latestTag: string | null
  lastAnnouncedVersion: string | null
  /** Memoized on the tag: `status.get` is client-polled and step building stats the filesystem. */
  cachedSteps: { tag: string; steps: string[] } | null
}

let reportState: ReportState | null = null
let checkTimer: ReturnType<typeof setTimeout> | null = null

/**
 * The active update method, read only from evidence the running install carries: the packaged
 * package-type marker `electron-updater` itself uses, and the AppImage runtime's own environment.
 * Nothing else is consulted, so an install that proves nothing reports `unknown`.
 */
export function detectServeUpdateMethod(): ServeManualUpdateMethod {
  // Why: repackagers (AUR, Nix, container rebuilds) inherit Orca's `package-type` marker verbatim,
  // so a `deb` marker on a host with no dpkg/apt describes the artifact, not the system that owns
  // the install (#18100). Reporting `deb` there would advise a download it could never apply.
  if (isExternallyManagedLinuxInstall()) {
    return 'externally-managed'
  }
  const packageType = getLinuxRootPackageType()
  if (packageType) {
    return packageType
  }
  if (process.platform !== 'linux') {
    return 'unknown'
  }
  if (process.env.APPIMAGE) {
    return 'appimage'
  }
  // Why: AppRun exports APPDIR for an extracted tree, where no single binary swap applies.
  return process.env.APPDIR ? 'extracted-appimage' : 'unknown'
}

/**
 * The manual update contract for this host, or null when nothing started reporting one.
 *
 * Null is not "up to date" — it means this process never entered a mode that owns the contract,
 * so callers must keep treating an absent report as unknown.
 */
export function getServeManualUpdateReport(): ServeManualUpdateReport | null {
  if (!reportState) {
    return null
  }
  const { latestTag, latestVersion } = reportState
  const releaseUrl = latestTag ? getReleaseTagUrl(latestTag) : null
  if (latestTag && latestVersion && releaseUrl && reportState.cachedSteps?.tag !== latestTag) {
    reportState.cachedSteps = {
      tag: latestTag,
      steps: buildServeManualUpdateSteps({
        method: reportState.method,
        latestVersion,
        releaseUrl,
        appImagePath: reportState.appImagePath
      })
    }
  }
  const cached = latestTag ? reportState.cachedSteps : null
  return {
    method: reportState.method,
    check: reportState.check,
    currentVersion: app.getVersion(),
    latestVersion,
    releaseUrl,
    steps: cached?.tag === latestTag ? cached.steps : [],
    documentationUrl: getServeUpgradeDocUrl()
  }
}

async function runServeUpdateCheck(): Promise<void> {
  const state = reportState
  if (!state) {
    return
  }
  const currentVersion = app.getVersion()
  const result = await fetchNewerReleaseTagsWithReadiness(currentVersion, 1, {
    includePrerelease: isPrereleaseVersion(currentVersion)
  })
  if (state !== reportState) {
    return
  }
  if (result.state === 'no-newer') {
    state.check = 'current'
    state.latestVersion = null
    state.latestTag = null
    state.cachedSteps = null
    return
  }
  const tag = result.state === 'ready' ? (result.tags[0] ?? null) : null
  if (!tag) {
    // Why: a feed failure and a mid-publish release both mean "not proven", so keep the last
    // known target rather than inventing a version the operator could not download yet.
    state.check = 'unavailable'
    return
  }
  state.check = 'update-available'
  state.latestTag = tag
  state.latestVersion = normalizeTagToVersion(tag)
  if (state.lastAnnouncedVersion === state.latestVersion) {
    return
  }
  // Bounded by construction: one record per newly observed version, not per check.
  state.lastAnnouncedVersion = state.latestVersion
  recordUpdaterLifecycle(
    'headless_serve_update_available',
    { method: state.method, currentVersion, latestVersion: state.latestVersion },
    {
      level: 'warn',
      message: `Orca ${state.latestVersion} is available; this install updates manually — run \`orca status\` for the exact commands`
    }
  )
}

function scheduleNextCheck(intervalMs: number): void {
  checkTimer = setTimeout(() => {
    void runCheckThenSchedule(intervalMs)
  }, intervalMs)
  checkTimer.unref?.()
}

async function runCheckThenSchedule(intervalMs: number): Promise<void> {
  await runServeUpdateCheck()
  if (reportState) {
    scheduleNextCheck(intervalMs)
  }
}

/**
 * Starts the status-only update contract for a headless serve host: detect the install method,
 * then poll the release feed on the same daily cadence the desktop updater uses. This never
 * downloads, installs, or restarts anything — it only makes the gap observable.
 */
export function startServeManualUpdateReporting(options: {
  installMode: RemoteServerUpdateInstallMode
  intervalMs?: number
}): Promise<void> {
  // Why: only the mode whose status branch publishes this report may pay for the check. A
  // supervised or interactive host would otherwise fetch the feed and log advice pointing at a
  // status surface that never carries it.
  if (reportState || options.installMode !== 'unsupported-headless-serve') {
    return Promise.resolve()
  }
  reportState = {
    method: detectServeUpdateMethod(),
    appImagePath: process.env.APPIMAGE ?? null,
    check: 'pending',
    latestVersion: null,
    latestTag: null,
    lastAnnouncedVersion: null,
    cachedSteps: null
  }
  if (process.env[SERVE_DISABLE_UPDATE_CHECK_ENV]) {
    reportState.check = 'disabled'
    return Promise.resolve()
  }
  if (!app.isPackaged || is.dev) {
    // Why: an unpackaged host has no release to compare against; report the method and stop.
    reportState.check = 'unavailable'
    return Promise.resolve()
  }
  return runCheckThenSchedule(options.intervalMs ?? AUTO_UPDATE_CHECK_INTERVAL_MS)
}

export function stopServeManualUpdateReporting(): void {
  if (checkTimer) {
    clearTimeout(checkTimer)
    checkTimer = null
  }
  reportState = null
}
