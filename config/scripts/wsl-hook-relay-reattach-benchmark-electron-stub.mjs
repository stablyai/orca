/**
 * Minimal `electron` module for wsl-hook-relay-reattach-benchmark.mjs, which loads the real
 * src/main/ipc/pty.ts under plain node. Only the surfaces that main's PTY graph touches are
 * implemented; everything else stays undefined so an unexpected dependency fails loudly.
 */
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const userDataPath = process.env.ORCA_USER_DATA_PATH ?? tmpdir()

export const BrowserWindow = undefined

export const app = {
  isPackaged: false,
  getVersion: () => '0.0.0-wsl-relay-benchmark',
  getName: () => 'orca-wsl-relay-benchmark',
  getPath: (name) => {
    if (name === 'userData') {
      return userDataPath
    }
    if (name === 'temp') {
      return tmpdir()
    }
    if (name === 'home') {
      return homedir()
    }
    return join(userDataPath, name)
  },
  on: () => {},
  once: () => {},
  whenReady: () => Promise.resolve()
}

export const ipcMain = {
  handle: () => {},
  handleOnce: () => {},
  on: () => {},
  once: () => {},
  removeHandler: () => {},
  removeAllListeners: () => {}
}

export const powerMonitor = { on: () => {}, once: () => {} }
export const nativeTheme = { shouldUseDarkColors: false, on: () => {} }
export const shell = { openPath: async () => '', openExternal: async () => {} }
export const dialog = { showMessageBox: async () => ({ response: 0 }) }
export const safeStorage = { isEncryptionAvailable: () => false }
export const clipboard = { readText: () => '', writeText: () => {} }
export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) }
export const session = { defaultSession: undefined }

export default {
  BrowserWindow,
  app,
  ipcMain,
  powerMonitor,
  nativeTheme,
  shell,
  dialog,
  safeStorage,
  clipboard,
  screen,
  session
}
