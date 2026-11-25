import { getChromeExtensionOrigin } from '../../../../shared/browser/extensions/browser-extension-url'
import { openHiddenHelperWindow } from '../../hidden-helper-window'

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
  const window = openHiddenHelperWindow(session)
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
