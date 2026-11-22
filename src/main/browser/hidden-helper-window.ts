import { BrowserWindow } from 'electron'

const helperContents = new WeakSet<Electron.WebContents>()
// Why: web-contents-created and browser-window-created fire inside the BrowserWindow constructor, before helperContents.add.
let creatingHelperWindow = false

/** Hidden windows Orca opens for its own work in a session: never tabs, popouts or the app window. */
export function isHiddenHelperContents(contents: Electron.WebContents): boolean {
  return creatingHelperWindow || helperContents.has(contents)
}

export function openHiddenHelperWindow(session: Electron.Session): BrowserWindow {
  creatingHelperWindow = true
  try {
    const window = new BrowserWindow({
      show: false,
      webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    helperContents.add(window.webContents)
    return window
  } finally {
    creatingHelperWindow = false
  }
}
