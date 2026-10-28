import { MessageChannelMain } from 'electron'
import { BROWSER_EXTENSION_FRAME_LIFETIME_CHANNEL } from '../../../shared/browser-extension-channels'
import { abortWhenRendererGone } from '../../ipc/renderer-lifetime-abort'

export type FrameContext = {
  extensionId: string
  webContentsId: number
  processId: number
  routingId: number
  events: Set<string>
  filters: Map<string, unknown[]>
  dispose: () => void
}

const trackedWebContents = new WeakSet<Electron.WebContents>()

export function forgetBrowserExtensionFrame(
  frames: Map<string, FrameContext>,
  key: string,
  context: FrameContext
): void {
  if (frames.get(key) !== context) {
    return
  }
  frames.delete(key)
  context.dispose()
}

export function createBrowserExtensionFrameContext(
  frames: Map<string, FrameContext>,
  key: string,
  extensionId: string,
  webContentsId: number,
  frame: Electron.WebFrameMain
): FrameContext {
  const { port1, port2 } = new MessageChannelMain()
  let disposed = false
  const retire = (): void => forgetBrowserExtensionFrame(frames, key, context)
  const context: FrameContext = {
    extensionId,
    webContentsId,
    processId: frame.processId,
    routingId: frame.routingId,
    events: new Set(),
    filters: new Map(),
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      port1.removeListener('close', retire)
      port1.close()
    }
  }
  frames.set(key, context)
  port1.once('close', retire)
  try {
    port1.start()
    // Native frame teardown closes the peer without needing an unload callback.
    frame.postMessage(BROWSER_EXTENSION_FRAME_LIFETIME_CHANNEL, null, [port2])
  } catch (error) {
    forgetBrowserExtensionFrame(frames, key, context)
    port2.close()
    throw error
  }
  return context
}

export function trackBrowserExtensionDocument(
  webContents: Electron.WebContents,
  currentFrames: () => Map<string, FrameContext> | undefined
): void {
  if (trackedWebContents.has(webContents)) {
    return
  }
  trackedWebContents.add(webContents)
  const webContentsId = webContents.id
  abortWhenRendererGone(webContents).signal.addEventListener('abort', () => {
    trackedWebContents.delete(webContents)
    const frames = currentFrames()
    if (!frames) {
      return
    }
    for (const [key, context] of frames) {
      if (context.webContentsId === webContentsId) {
        forgetBrowserExtensionFrame(frames, key, context)
      }
    }
  })
}
