import { app } from 'electron'

let loggedForkSwitch = false

// Fork-only (FORK.md): keeps an upstream release from replacing this build.
export function runsAutoUpdater(): boolean {
  if (!app.isPackaged) {
    return false
  }
  if (import.meta.env.MAIN_VITE_ORCA_FORK_NO_AUTO_UPDATE !== '1') {
    return true
  }
  if (!loggedForkSwitch) {
    loggedForkSwitch = true
    console.info('[updater] Fork build: auto-update is off (MAIN_VITE_ORCA_FORK_NO_AUTO_UPDATE=1)')
  }
  return false
}
