import type { RemoteServerUpdateSupport } from '../shared/remote-server-update'
import type { UpdateStatus } from '../shared/update-status-types'

export type UpdateCommandResult = {
  operation: 'check' | 'update'
  status: UpdateStatus
  installRequested: boolean
  timedOut?: boolean
  support?: RemoteServerUpdateSupport
}

/** Renders the `orca version` result as the bare version string for humans. */
export function formatAppVersion(result: { version: string }): string {
  return result.version
}

/**
 * Renders the final human-readable line for `orca update` / `orca update --check`.
 * Covers timeouts, the SSH/headless/dev cases where the app can't self-update, and
 * every terminal updater state.
 */
export function formatUpdateResult(result: UpdateCommandResult): string {
  const { status, support } = result
  if (result.timedOut) {
    if (status.state === 'downloading') {
      return `Timed out waiting for Orca ${status.version} to download (${formatPercent(status.percent)}).`
    }
    return 'Timed out waiting for Orca to finish checking for updates.'
  }

  // Why: when the running Orca can't drive its own updater (dev build, headless
  // serve, updater not ready), report why with next steps instead of a raw state.
  if (support && !support.automatic) {
    return formatUnavailableSupport(support)
  }

  switch (status.state) {
    case 'available':
      return `Update available: Orca ${status.version}.`
    case 'not-available':
      return 'Orca is up to date.'
    case 'error':
      return `${result.operation === 'check' ? 'Update check' : 'Update'} failed: ${status.message}`
    case 'downloaded':
      return result.installRequested
        ? `Installing Orca ${status.version}. Orca will quit and restart to finish the update.`
        : `Orca ${status.version} is downloaded and ready to install.`
    case 'downloading':
      return `Downloading Orca ${status.version}: ${formatPercent(status.percent)}`
    case 'checking':
      return 'Checking for Orca updates...'
    case 'idle':
      return 'The Orca updater is idle.'
  }
}

/** Explains why the running Orca can't update itself, per the support reason. */
function formatUnavailableSupport(support: RemoteServerUpdateSupport): string {
  switch (support.reason) {
    case 'unpackaged-build':
      return 'Updates are unavailable in a development build of Orca.'
    case 'updater-unavailable':
      return 'The Orca updater is not ready yet. Try again in a moment.'
    case 'manual-service-update-required':
      return 'This Orca runs as a headless service, so it cannot update itself. Update it through its service manager (e.g. redeploy or restart the orca serve process).'
    case 'available':
      // Why: 'available' pairs with automatic=true, so this branch is unreachable;
      // kept exhaustive so a future reason can't silently fall through.
      return 'Orca cannot update itself right now.'
  }
}

/**
 * Renders a live progress line for an in-flight update, or `null` for states that
 * carry no progress to show (idle / not-available / error).
 */
export function formatUpdateProgress(status: UpdateStatus): string | null {
  switch (status.state) {
    case 'checking':
      return 'Checking for Orca updates...'
    case 'available':
      return `Update available: Orca ${status.version}. Downloading...`
    case 'downloading':
      return `Downloading Orca ${status.version}… ${formatPercent(status.percent)}`
    case 'downloaded':
      return `Orca ${status.version} downloaded. Requesting installation...`
    case 'idle':
    case 'not-available':
    case 'error':
      return null
  }
}

/** Clamps a download percentage to 0–100 and renders it as a whole-number percent. */
function formatPercent(percent: number): string {
  return `${Math.max(0, Math.min(100, percent)).toFixed(0)}%`
}
