import { BrowserWindow, type Session } from 'electron'
import { acquireElectronDebugger } from './electron-debugger-lease'

export type CookieDebuggerSession = {
  debugger: {
    sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  }
  dispose: () => void
}

export async function leaseCookieDebuggerSession(
  targetSession: Session
): Promise<CookieDebuggerSession> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      session: targetSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  try {
    await window.loadURL('data:text/html,<!doctype html><title>cookie-clear</title>')
    const contents = window.webContents
    if (contents.isDestroyed()) {
      throw new Error('Could not attach to the cookie session for an atomic clear')
    }
    const lease = acquireElectronDebugger(contents)
    let disposed = false
    return {
      debugger: contents.debugger,
      dispose: () => {
        if (disposed) {
          return
        }
        disposed = true
        try {
          lease.release()
        } finally {
          if (!contents.isDestroyed()) {
            window.destroy()
          }
        }
      }
    }
  } catch (error) {
    window.destroy()
    throw error
  }
}
