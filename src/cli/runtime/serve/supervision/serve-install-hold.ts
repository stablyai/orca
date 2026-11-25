import { existsSync, statSync } from 'node:fs'
import {
  isShipItRunningForBundle,
  listProcessCommands
} from '../../../../shared/desktop-distribution/macos/shipit-process-listing'
import { macAppBundleOf } from '../../../../shared/remote-runtime/serve-supervisor/serve-bundle-coordination'

export type ServeInstallEvidence =
  | { kind: 'clear' }
  | {
      kind: 'hold'
      reason: 'bundle-missing' | 'installer-running' | 'installer-unknown' | 'install-park'
    }

export const SERVE_INSTALL_HOLD_REASON_TEXT: Record<
  Extract<ServeInstallEvidence, { kind: 'hold' }>['reason'],
  string
> = {
  'bundle-missing': 'the Orca executable is missing, likely mid-install',
  'installer-running': "macOS's updater (ShipIt) is replacing this Orca app",
  'installer-unknown':
    "could not check whether macOS's updater (ShipIt) is replacing this Orca app",
  'install-park': 'the Orca desktop app paused this server to install an update'
}

type ListProcesses = () => Promise<string | null>

/** Installer swaps can expose mixed code or kill a child mid-start; hold spawns until they finish. */
export async function readServeInstallEvidence(
  executable: string,
  options: { platform?: NodeJS.Platform; listProcesses?: ListProcesses } = {}
): Promise<ServeInstallEvidence> {
  const platform = options.platform ?? process.platform
  const bundlePath = platform === 'darwin' ? macAppBundleOf(executable) : null
  // ShipIt temporarily removes the executable during swaps; do not treat that as uninstall.
  if (bundlePath) {
    const listing = await (options.listProcesses ?? listProcessCommands)()
    if (listing === null) {
      return { kind: 'hold', reason: 'installer-unknown' }
    }
    if (isShipItRunningForBundle(listing, bundlePath)) {
      return { kind: 'hold', reason: 'installer-running' }
    }
  }
  return existsSync(executable) ? { kind: 'clear' } : { kind: 'hold', reason: 'bundle-missing' }
}

/** Include the archive: Linux releases can share one Electron launcher binary. */
export function serveBuildIdentity(executable: string, appRoot?: string): string {
  return [executable, ...(appRoot ? [appRoot] : [])]
    .map((path) => {
      try {
        const stat = statSync(path)
        return `${stat.size}:${Math.trunc(stat.mtimeMs)}`
      } catch {
        return 'missing'
      }
    })
    .join('|')
}
