import { BrowserWindow } from 'electron'
import { getChromeExtensionOrigin } from '../../../../shared/browser/extensions/browser-extension-url'
import {
  getBrowserExtensionExecution,
  trackBrowserExtensionExecutionOperation,
  type BrowserExtensionExecution
} from './browser-extension-execution-authority'

const nativePages = new WeakSet<Electron.WebContents>()
// web-contents-created fires inside the constructor, before nativePages.add.
let creatingNativePage = false

export function isBrowserExtensionNativePage(contents: Electron.WebContents): boolean {
  return creatingNativePage || nativePages.has(contents)
}

type NativePageOptions = {
  session: Electron.Session
  extensionId: string
  code: string
  timeoutMs?: number
  signal?: AbortSignal
}

/** Native bindings only. The execution owns the receiver through actual WebContents teardown. */
export class BrowserExtensionNativePage {
  private readonly window: BrowserWindow
  private readonly contents: Electron.WebContents
  private readonly ready: Promise<unknown>
  private readonly destroyed: Promise<void>
  private closing = false
  private readonly closeOnRetirement = (): void => {
    void this.destroy()
  }

  constructor(private readonly execution: BrowserExtensionExecution) {
    execution.controller.signal.throwIfAborted()
    creatingNativePage = true
    try {
      this.window = new BrowserWindow({
        show: false,
        webPreferences: {
          session: execution.session,
          sandbox: true,
          contextIsolation: false,
          nodeIntegration: false
        }
      })
    } finally {
      creatingNativePage = false
    }
    this.contents = this.window.webContents
    nativePages.add(this.contents)
    this.contents.once('render-process-gone', this.closeOnRetirement)
    this.destroyed = new Promise<void>((resolve) => {
      if (this.contents.isDestroyed()) {
        resolve()
      } else {
        this.contents.once('destroyed', resolve)
      }
    })
    execution.operations.add(this.destroyed)
    void this.destroyed.then(() => {
      execution.operations.delete(this.destroyed)
      this.contents.removeListener('render-process-gone', this.closeOnRetirement)
      execution.controller.signal.removeEventListener('abort', this.closeOnRetirement)
    })
    execution.controller.signal.addEventListener('abort', this.closeOnRetirement, { once: true })
    this.ready = this.window.loadURL(
      `${getChromeExtensionOrigin(execution.extensionId)}/manifest.json?orca-native-page=1`
    )
    void this.ready.catch(() => {})
    if (execution.controller.signal.aborted) {
      this.closeOnRetirement()
    }
  }

  destroy(): Promise<void> {
    if (!this.closing) {
      this.closing = true
      if (!this.contents.isDestroyed()) {
        this.window.destroy()
      }
    }
    return this.destroyed
  }

  run(code: string, timeoutMs?: number, callerSignal?: AbortSignal): Promise<unknown> {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, this.execution.controller.signal])
      : this.execution.controller.signal
    return trackBrowserExtensionExecutionOperation(this.execution, async () => {
      signal.throwIfAborted()
      if (this.closing) {
        throw new Error('Extension context was unloaded')
      }
      let timer: NodeJS.Timeout | undefined
      let onAbort: (() => void) | undefined
      try {
        return await Promise.race([
          (async () => {
            await this.ready
            signal.throwIfAborted()
            if (this.closing || this.contents.isDestroyed()) {
              throw new Error('Extension context was unloaded')
            }
            return this.contents.executeJavaScript(code)
          })(),
          new Promise<never>((_resolve, reject) => {
            if (timeoutMs !== undefined) {
              timer = setTimeout(
                () => reject(new Error('Native extension operation timed out')),
                timeoutMs
              )
            }
            onAbort = () => reject(new Error('Extension context was unloaded'))
            signal.addEventListener('abort', onAbort, { once: true })
            if (signal.aborted) {
              onAbort()
            }
          }),
          this.destroyed.then(() => {
            throw new Error('Extension context was unloaded')
          })
        ])
      } catch (error) {
        // A timed-out request can still dispatch until its frame receiver is gone.
        await this.destroy()
        throw error
      } finally {
        clearTimeout(timer)
        if (onAbort) {
          signal.removeEventListener('abort', onAbort)
        }
      }
    })
  }
}

/** Occasional native operations release their document immediately; quota owns its own handle. */
export async function runBrowserExtensionNativePage(options: NativePageOptions): Promise<unknown> {
  options.signal?.throwIfAborted()
  const execution = getBrowserExtensionExecution(options.session, options.extensionId)
  if (!execution) {
    throw new Error('Extension context was unloaded')
  }
  const page = new BrowserExtensionNativePage(execution)
  try {
    return await page.run(options.code, options.timeoutMs, options.signal)
  } finally {
    await page.destroy()
  }
}

/** Main-authored expression; values never become executable source. */
export function browserExtensionNativeValue(value: unknown): string {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes =
      value instanceof ArrayBuffer
        ? Buffer.from(value)
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    return `Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),c=>c.charCodeAt(0)).buffer`
  }
  if (Array.isArray(value)) {
    return `[${value.map(browserExtensionNativeValue).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `Object.fromEntries([${Object.entries(value)
      .map(([key, entry]) => `[${JSON.stringify(key)},${browserExtensionNativeValue(entry)}]`)
      .join(',')}])`
  }
  return value === undefined ? 'undefined' : JSON.stringify(value)
}
