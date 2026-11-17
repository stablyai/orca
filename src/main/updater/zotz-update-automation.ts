import type { UpdateStatus } from '../../shared/update-status-types'

/** A server node installs only after this long with no agent working (docs/zotz/UPDATES-SPEC.md §5.4). */
export const ZOTZ_SERVER_IDLE_INSTALL_MS = 10 * 60_000
const IDLE_POLL_MS = 60_000

type ZotzUpdateAutomationDeps = {
  getWorkingAgentCount: () => number
  isServerMode: () => boolean
}

type ZotzUpdateActions = {
  download: () => void
  install: () => void
}

/** Counts how long the node has had no agent working; any agent restarts the wait. */
export class ZotzServerIdleInstallClock {
  private idleSince: number | null = null

  shouldInstall(workingAgents: number, now: number): boolean {
    if (workingAgents > 0) {
      this.idleSince = null
      return false
    }
    this.idleSince ??= now
    return now - this.idleSince >= ZOTZ_SERVER_IDLE_INSTALL_MS
  }
}

// Unsigned macOS builds cannot install updates and deb/rpm installs are the package manager's job.
function canInstallDownloadedUpdates(): boolean {
  return process.platform === 'win32' || Boolean(process.env.APPIMAGE)
}

let deps: ZotzUpdateAutomationDeps | null = null
let actions: ZotzUpdateActions | null = null
let downloadRequestedFor: string | null = null
let idleTimer: ReturnType<typeof setInterval> | null = null

export function configureZotzUpdateAutomation(next: ZotzUpdateAutomationDeps): void {
  deps = next
}

export function registerZotzUpdateActions(next: ZotzUpdateActions): void {
  actions = next
}

function stopIdleInstallWatch(): void {
  if (idleTimer) {
    clearInterval(idleTimer)
    idleTimer = null
  }
}

function startIdleInstallWatch(): void {
  if (idleTimer) {
    return
  }
  const clock = new ZotzServerIdleInstallClock()
  idleTimer = setInterval(() => {
    if (!deps?.isServerMode()) {
      stopIdleInstallWatch()
      return
    }
    if (clock.shouldInstall(deps.getWorkingAgentCount(), Date.now())) {
      stopIdleInstallWatch()
      actions?.install()
    }
  }, IDLE_POLL_MS)
  idleTimer.unref?.()
}

/** Downloads a found release in the background; a server node then installs once idle. */
export function observeZotzUpdateStatus(status: UpdateStatus): void {
  // Unconfigured until app startup wires it, so updater suites keep upstream's click-to-download flow.
  if (!deps || !canInstallDownloadedUpdates()) {
    return
  }
  if (status.state === 'available' && status.version !== downloadRequestedFor) {
    downloadRequestedFor = status.version
    actions?.download()
    return
  }
  if (status.state === 'downloaded' && !('installing' in status && status.installing)) {
    if (deps?.isServerMode()) {
      startIdleInstallWatch()
    }
    return
  }
  if (status.state !== 'downloading') {
    stopIdleInstallWatch()
  }
}
