import { app } from 'electron'
import { createWslDistroHolder, type WslDistroHolder } from '../wsl/wsl-distro-holder'
import { ensureWindowsAppDataPath } from './windows-app-data-path'
import {
  stopWslHostServersForUninstall,
  wslHostUninstallStopDependencies,
  type WslHostUninstallStopDependencies
} from '../wsl/wsl-host-uninstall-server-stop'

/** The NSIS uninstaller's flag (config/nsis/orca-installer-hooks.nsh); keep the two in sync. */
export const WSL_HOLDER_UNINSTALL_FLAG = '--orca-uninstall-release-wsl-holders'
/** Added only by the last install for this user: its HKCU/HKLM twin shares these hosts' servers. */
export const WSL_SERVER_UNINSTALL_FLAG = '--orca-uninstall-stop-wsl-servers'

// Uninstall must finish even if the process table or a distro never answers.
const UNINSTALL_RELEASE_TIMEOUT_MS = 45_000

/** Exit code 0 only when every recorded holder is proven gone; unverifiable ones are left running.
 * Then each running host's server is stopped too, best effort, so its distro can stop. */
export async function releaseWslHoldersForUninstall(
  holder: WslDistroHolder,
  servers?: WslHostUninstallStopDependencies
): Promise<number> {
  let code: number
  try {
    const released = await holder.releaseAll({ forUninstall: true })
    for (const { distro, state } of released) {
      if (state !== 'exited') {
        console.warn(`[wsl] uninstall left the ${distro} holder ${state}`)
      }
    }
    code = released.every(({ state }) => state === 'exited') ? 0 : 1
  } catch (error) {
    console.warn('[wsl] uninstall could not release WSL distro holders:', error)
    code = 1
  }
  if (servers) {
    // Never changes the exit code: a server left running costs memory, not a broken uninstall.
    await stopWslHostServersForUninstall(servers).catch((error: unknown) => {
      console.warn('[wsl] uninstall could not stop WSL host servers:', error)
    })
  }
  return code
}

/** Uninstall only: ends the holders this profile recorded and its hosts' servers, so distros can stop. */
export function runWslHolderUninstallPreflight(argv: readonly string[] = process.argv): boolean {
  if (!argv.includes(WSL_HOLDER_UNINSTALL_FLAG)) {
    return false
  }
  // Armed first: nothing below may leave the uninstaller waiting on an error box.
  const timeout = setTimeout(() => app.exit(1), UNINSTALL_RELEASE_TIMEOUT_MS)
  let holder: WslDistroHolder
  let servers: WslHostUninstallStopDependencies | undefined
  try {
    process.env.ORCA_BACKGROUND_LAUNCH = '1'
    // The same userData the app records holders under; before any other preflight step.
    ensureWindowsAppDataPath(app)
    holder = createWslDistroHolder({ userDataPath: app.getPath('userData') })
    servers = argv.includes(WSL_SERVER_UNINSTALL_FLAG)
      ? wslHostUninstallStopDependencies(app.getPath('userData'))
      : undefined
  } catch (error) {
    console.warn('[wsl] uninstall could not start releasing WSL distro holders:', error)
    clearTimeout(timeout)
    app.exit(1)
    return true
  }
  void releaseWslHoldersForUninstall(holder, servers).then((code) => {
    clearTimeout(timeout)
    app.exit(code)
  })
  return true
}
