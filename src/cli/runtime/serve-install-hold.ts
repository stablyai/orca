import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { isShipItRunningForBundle, listProcessCommands } from '../../shared/shipit-process-listing'

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

/**
 * Whether a supervised serve may spawn from `executable` right now. Never spawn from a bundle an
 * installer is swapping: the child would run half-old, half-new code or be killed mid-start.
 */
export async function readServeInstallEvidence(
  executable: string,
  options: { platform?: NodeJS.Platform; listProcesses?: ListProcesses } = {}
): Promise<ServeInstallEvidence> {
  const platform = options.platform ?? process.platform
  const bundlePath = platform === 'darwin' ? macBundlePathOf(executable) : null
  // Why ShipIt first: mid-swap the executable is briefly missing, and that must not look like removal.
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

function macBundlePathOf(executable: string): string | null {
  const bundle = dirname(dirname(dirname(executable)))
  return bundle.endsWith('.app') ? bundle : null
}

/**
 * Changes whenever the installed app does, so a new build starts with a clean restart count. The
 * app archive is included because Linux releases on one Electron version share the launcher binary.
 */
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
