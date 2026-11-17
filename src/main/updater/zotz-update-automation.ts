import type { UpdateStatus } from '../../shared/update-status-types'

/** A server node installs only after this long with no agent working (docs/zotz/UPDATES-SPEC.md §5.4). */
export const ZOTZ_SERVER_IDLE_INSTALL_MS = 10 * 60_000

type ZotzUpdateAutomationDeps = {
  getWorkingAgentCount: () => number
  isServerMode: () => boolean
  /** Fires whenever an agent's reported state changes, so idleness is re-judged without polling. */
  subscribeAgentActivity: (listener: () => void) => () => void
}

type ZotzUpdateActions = {
  download: () => void
  install: () => void
}

// Unsigned macOS builds cannot install updates and deb/rpm installs are the package manager's job.
function canInstallDownloadedUpdates(): boolean {
  return process.platform === 'win32' || Boolean(process.env.APPIMAGE)
}

let deps: ZotzUpdateAutomationDeps | null = null
let actions: ZotzUpdateActions | null = null
let downloadRequestedFor: string | null = null
let installPending = false
let idleInstallTimer: ReturnType<typeof setTimeout> | null = null

function cancelIdleInstall(): void {
  if (idleInstallTimer) {
    clearTimeout(idleInstallTimer)
    idleInstallTimer = null
  }
}

/** Arms one 10-minute wait while the node is idle; any working agent cancels it until it is idle again. */
function judgeIdleInstall(): void {
  if (!installPending || !deps?.isServerMode()) {
    cancelIdleInstall()
    return
  }
  if (deps.getWorkingAgentCount() > 0) {
    cancelIdleInstall()
    return
  }
  if (idleInstallTimer) {
    return
  }
  idleInstallTimer = setTimeout(() => {
    idleInstallTimer = null
    if (installPending && deps?.isServerMode() && deps.getWorkingAgentCount() === 0) {
      installPending = false
      actions?.install()
    }
  }, ZOTZ_SERVER_IDLE_INSTALL_MS)
  idleInstallTimer.unref?.()
}

export function configureZotzUpdateAutomation(next: ZotzUpdateAutomationDeps): () => void {
  deps = next
  const unsubscribe = next.subscribeAgentActivity(judgeIdleInstall)
  return () => {
    unsubscribe()
    cancelIdleInstall()
    deps = null
  }
}

export function registerZotzUpdateActions(next: ZotzUpdateActions): void {
  actions = next
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
  if (status.state === 'downloaded') {
    installPending = status.installing !== true
    judgeIdleInstall()
    return
  }
  if (status.state !== 'downloading') {
    installPending = false
    cancelIdleInstall()
  }
}
