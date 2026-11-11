import { app } from 'electron'

let loggedForkSwitch = false

// Fork-only (FORK.md): off in every non-DEV build, so no build flag or mode can let upstream replace it.
export function runsAutoUpdater(): boolean {
  if (!app.isPackaged) {
    return false
  }
  if (import.meta.env.DEV === true) {
    return true
  }
  if (!loggedForkSwitch) {
    loggedForkSwitch = true
    console.info('[updater] Fork build: auto-update is off')
  }
  return false
}
