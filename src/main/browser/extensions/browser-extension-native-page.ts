import { BrowserWindow } from 'electron'
import { getChromeExtensionOrigin } from '../../../shared/browser-extension-url'

const nativePages = new WeakSet<Electron.WebContents>()
// Why: web-contents-created fires inside the BrowserWindow constructor, before nativePages.add.
let creatingNativePage = false

export function isBrowserExtensionNativePage(contents: Electron.WebContents): boolean {
  return creatingNativePage || nativePages.has(contents)
}

/** Native extension bindings without Orca's API wrappers, always on a hidden document. */
export async function runBrowserExtensionNativePage(options: {
  session: Electron.Session
  extensionId: string
  code: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<unknown> {
  const { session, extensionId, code, timeoutMs, signal } = options
  signal?.throwIfAborted()
  creatingNativePage = true
  let window: BrowserWindow
  try {
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
  } finally {
    creatingNativePage = false
  }
  nativePages.add(window.webContents)
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      (async () => {
        await window.loadURL(
          `${getChromeExtensionOrigin(extensionId)}/manifest.json?orca-native-page=1`
        )
        signal?.throwIfAborted()
        return window.webContents.executeJavaScript(code)
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Native extension operation timed out')),
          timeoutMs
        )
        onAbort = () => reject(new Error('Extension context was unloaded'))
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) {
          onAbort()
        }
      })
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) {
      signal?.removeEventListener('abort', onAbort)
    }
    window.destroy()
  }
}
