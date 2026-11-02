import { BrowserWindow, type Session } from 'electron'
import { acquireElectronDebugger } from '../electron-debugger-lease'

export type CookieClearDebugger = {
  sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

type CookieClearSession = {
  debugger: CookieClearDebugger
  dispose: () => void
}

function openHiddenCookieWindow(targetSession: Session): BrowserWindow {
  return new BrowserWindow({
    show: false,
    webPreferences: {
      session: targetSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
}

const COOKIE_COMMAND_DEADLINE_MS = 10_000

async function attachCookieClearSession(
  targetSession: Session,
  signal: AbortSignal
): Promise<CookieClearSession> {
  // A dedicated target can be retired without closing a user's tab or another debugger lease.
  const window = openHiddenCookieWindow(targetSession)
  let retired = false
  const retire = () => {
    if (!retired) {
      retired = true
      window.destroy()
    }
  }
  signal.addEventListener('abort', retire, { once: true })
  try {
    await window.loadURL('data:text/html,<!doctype html><title>cookie-clear</title>')
    signal.throwIfAborted()
    const contents = window.webContents
    if (contents.isDestroyed()) {
      throw new Error('Could not attach to the cookie session')
    }
    const lease = acquireElectronDebugger(contents)
    return {
      debugger: contents.debugger,
      dispose: () => {
        signal.removeEventListener('abort', retire)
        try {
          lease.release()
        } finally {
          retire()
        }
      }
    }
  } catch (error) {
    signal.removeEventListener('abort', retire)
    retire()
    throw error
  }
}

export function openCookieDebuggerSession(targetSession: Session) {
  let attached: CookieClearSession | null = null
  let pendingAttach: Promise<CookieClearSession> | null = null
  let disposed = false
  const retirement = new AbortController()
  const dispose = () => {
    disposed = true
    try {
      attached?.dispose()
    } finally {
      attached = null
      retirement.abort()
    }
  }
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (disposed) {
      throw new Error('Cookie clear store was disposed')
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            // Destroy/detach synchronously before allowing the mutation lock to be released.
            dispose()
            reject(new Error('Cookie session command timed out'))
          }, COOKIE_COMMAND_DEADLINE_MS)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const attach = async () => {
    if (disposed) {
      throw new Error('Cookie clear store was disposed')
    }
    if (attached) {
      return attached
    }
    if (pendingAttach) {
      return pendingAttach
    }
    const pending = bounded(() => attachCookieClearSession(targetSession, retirement.signal)).then(
      (session) => {
        if (disposed) {
          session.dispose()
          throw new Error('Cookie clear store was disposed during debugger attachment')
        }
        attached = {
          dispose: session.dispose,
          debugger: {
            sendCommand: (method, params) =>
              bounded(() => session.debugger.sendCommand(method, params))
          }
        }
        return attached
      }
    )
    pendingAttach = pending
    try {
      return await pending
    } finally {
      if (pendingAttach === pending) {
        pendingAttach = null
      }
    }
  }
  return { attach, dispose }
}
