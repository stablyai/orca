import { Buffer } from 'node:buffer'
import type { WebContents } from 'electron'
import {
  BrowserScreencastOpcode,
  encodeBrowserScreencastFrame,
  type BrowserScreencastFormat,
  type BrowserScreencastFrameMetadata
} from '../../shared/browser-screencast-protocol'
import { BrowserError } from './cdp-bridge'
import { acquireElectronDebugger, type ElectronDebuggerLease } from './electron-debugger-lease'

const DEBUGGER_COMMAND_TIMEOUT_MS = 8_000

export type BrowserScreencastOptions = {
  format: BrowserScreencastFormat
  quality: number
  maxWidth: number
  maxHeight: number
  viewportWidth?: number
  viewportHeight?: number
  everyNthFrame: number
  onFrame: (bytes: Uint8Array<ArrayBufferLike>) => void
  onError?: (message: string) => void
}

export type BrowserScreencastSession = {
  stop: () => void
  done: Promise<void>
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readFrameMetadata(raw: unknown): BrowserScreencastFrameMetadata {
  const metadata = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    offsetTop: finiteNumber(metadata.offsetTop),
    pageScaleFactor: finiteNumber(metadata.pageScaleFactor),
    deviceWidth: finiteNumber(metadata.deviceWidth),
    deviceHeight: finiteNumber(metadata.deviceHeight),
    scrollOffsetX: finiteNumber(metadata.scrollOffsetX),
    scrollOffsetY: finiteNumber(metadata.scrollOffsetY),
    timestamp: finiteNumber(metadata.timestamp)
  }
}

function positiveInteger(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

async function sendDebuggerCommand(
  dbg: WebContents['debugger'],
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      Promise.resolve().then(() => dbg.sendCommand(method, params)),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out while running ${method}.`))
        }, DEBUGGER_COMMAND_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

export async function startBrowserScreencast(
  webContents: WebContents,
  options: BrowserScreencastOptions
): Promise<BrowserScreencastSession> {
  if (webContents.isDestroyed()) {
    throw new BrowserError('browser_tab_not_found', 'Browser tab is no longer available')
  }

  const dbg = webContents.debugger
  let debuggerLease: ElectronDebuggerLease | null = null
  try {
    debuggerLease = acquireElectronDebugger(webContents)
  } catch {
    throw new BrowserError(
      'browser_error',
      'Could not attach debugger. DevTools may already be open for this tab.'
    )
  }

  let closed = false
  let seq = 0
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const finish = (): void => {
    if (closed) {
      return
    }
    closed = true
    dbg.removeListener('message', handleMessage as never)
    dbg.removeListener('detach', handleDetach as never)
    debuggerLease?.release()
    debuggerLease = null
    resolveDone()
  }

  const handleDetach = (): void => {
    options.onError?.('Browser debugger detached while streaming.')
    finish()
  }

  const handleMessage = (_event: unknown, method: string, params: unknown): void => {
    if (closed || method !== 'Page.screencastFrame') {
      return
    }
    const payload = params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
    const data = typeof payload.data === 'string' ? payload.data : null
    const sessionId = typeof payload.sessionId === 'number' ? payload.sessionId : null
    if (!data || sessionId === null) {
      return
    }

    try {
      options.onFrame(
        encodeBrowserScreencastFrame({
          opcode: BrowserScreencastOpcode.Frame,
          seq: seq++,
          format: options.format,
          metadata: readFrameMetadata(payload.metadata),
          image: new Uint8Array(Buffer.from(data, 'base64'))
        })
      )
    } finally {
      // Why: CDP only sends the next screencast frame after the current frame
      // is acknowledged, so the ack is the back-pressure point for this feed.
      void sendDebuggerCommand(dbg, 'Page.screencastFrameAck', { sessionId }).catch(() => {})
    }
  }

  const emitInitialFrameIfNeeded = async (): Promise<void> => {
    if (closed || seq > 0) {
      return
    }
    try {
      // Why: Page.startScreencast may not produce a frame for an already-painted
      // blank/static page, which leaves remote browser clients showing only the shell.
      const result = await sendDebuggerCommand(dbg, 'Page.captureScreenshot', {
        format: options.format,
        ...(options.format === 'jpeg' ? { quality: options.quality } : {}),
        captureBeyondViewport: false
      })
      if (closed || seq > 0) {
        return
      }
      const payload =
        result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
      const data = typeof payload.data === 'string' ? payload.data : null
      if (!data) {
        return
      }
      options.onFrame(
        encodeBrowserScreencastFrame({
          opcode: BrowserScreencastOpcode.Frame,
          seq: seq++,
          format: options.format,
          metadata: {},
          image: new Uint8Array(Buffer.from(data, 'base64'))
        })
      )
    } catch {
      // Best effort only: live Page.screencastFrame events still drive the stream.
    }
  }

  dbg.on('message', handleMessage as never)
  dbg.on('detach', handleDetach as never)

  try {
    await sendDebuggerCommand(dbg, 'Page.enable')
    const viewportWidth = positiveInteger(options.viewportWidth)
    const viewportHeight = positiveInteger(options.viewportHeight)
    if (viewportWidth && viewportHeight) {
      // Why: the first frame must use the same CSS viewport as the client pane,
      // otherwise the image is scaled and input coordinates land off target.
      await sendDebuggerCommand(dbg, 'Emulation.setDeviceMetricsOverride', {
        width: viewportWidth,
        height: viewportHeight,
        deviceScaleFactor: 1,
        mobile: false
      })
    }
    await sendDebuggerCommand(dbg, 'Page.startScreencast', {
      format: options.format,
      quality: options.quality,
      maxWidth: options.maxWidth,
      maxHeight: options.maxHeight,
      everyNthFrame: options.everyNthFrame
    })
    void emitInitialFrameIfNeeded()
  } catch (error) {
    finish()
    throw new BrowserError(
      'browser_error',
      error instanceof Error ? error.message : 'Failed to start browser screencast.'
    )
  }

  return {
    stop: () => {
      if (closed) {
        return
      }
      try {
        void sendDebuggerCommand(dbg, 'Page.stopScreencast')
          .catch(() => {})
          .finally(finish)
      } catch {
        finish()
      }
    },
    done
  }
}
