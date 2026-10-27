import { app } from 'electron'
import { createWslDistroHolder, type WslDistroHolder } from '../wsl/wsl-distro-holder'
import { ensureWindowsAppDataPath } from './windows-app-data-path'

/** The NSIS uninstaller's flag (config/nsis/orca-installer-hooks.nsh); keep the two in sync. */
export const WSL_HOLDER_UNINSTALL_FLAG = '--orca-uninstall-release-wsl-holders'

// Uninstall must finish even if the process table never answers.
const UNINSTALL_RELEASE_TIMEOUT_MS = 30_000

/** Exit code 0 only when every recorded holder is proven gone; unverifiable ones are left running. */
export async function releaseWslHoldersForUninstall(holder: WslDistroHolder): Promise<number> {
  try {
    const released = await holder.releaseAll()
    for (const { distro, state } of released) {
      if (state !== 'exited') {
        console.warn(`[wsl] uninstall left the ${distro} holder ${state}`)
      }
    }
    return released.every(({ state }) => state === 'exited') ? 0 : 1
  } catch (error) {
    console.warn('[wsl] uninstall could not release WSL distro holders:', error)
    return 1
  }
}

/** Uninstall only: ends the `wsl.exe` holders this profile recorded, so its distros idle-stop. */
export function runWslHolderUninstallPreflight(argv: readonly string[] = process.argv): boolean {
  if (!argv.includes(WSL_HOLDER_UNINSTALL_FLAG)) {
    return false
  }
  // Armed first: nothing below may leave the uninstaller waiting on an error box.
  const timeout = setTimeout(() => app.exit(1), UNINSTALL_RELEASE_TIMEOUT_MS)
  let holder: WslDistroHolder
  try {
    process.env.ORCA_BACKGROUND_LAUNCH = '1'
    // The same userData the app records holders under; before any other preflight step.
    ensureWindowsAppDataPath(app)
    holder = createWslDistroHolder({ userDataPath: app.getPath('userData') })
  } catch (error) {
    console.warn('[wsl] uninstall could not start releasing WSL distro holders:', error)
    clearTimeout(timeout)
    app.exit(1)
    return true
  }
  void releaseWslHoldersForUninstall(holder).then((code) => {
    clearTimeout(timeout)
    app.exit(code)
  })
  return true
}
