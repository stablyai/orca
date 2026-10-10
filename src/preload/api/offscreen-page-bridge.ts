import { ipcRenderer, sharedTexture, webUtils } from 'electron'
import type {
  OffscreenPageCaret,
  OffscreenPageCommand,
  OffscreenPageDatalist,
  OffscreenPageGuestEvent,
  OffscreenPageSelectAnchor,
  OffscreenPageUserInput,
  OffscreenPageViewport
} from '../../shared/offscreen-page-protocol'

export type OffscreenPageListeners = {
  onEvent: (event: OffscreenPageGuestEvent) => void
  /** A CSS cursor value main built from the page's cursor-changed event. */
  onCursor: (cursor: string) => void
  /** The page opened a <select>; answer with showSelectMenu to draw its menu. */
  onSelect: (anchor: OffscreenPageSelectAnchor) => void
  /** The page's tooltip under the pointer, "" for none. */
  onTooltip: (text: string) => void
  /** The page's open datalist popup to draw, or null once it closes. */
  onDatalist: (datalist: OffscreenPageDatalist | null) => void
}

export type OffscreenPageApi = {
  /** Returns the page's WebContents id, or null when main refused the partition or URL. */
  create(args: {
    browserPageId: string
    partition: string
    src: string
    viewport: OffscreenPageViewport
  }): Promise<number | null>
  /** Frames for this page are drawn straight into `canvas`; VideoFrames can't cross the context bridge. */
  attach(browserPageId: string, canvas: HTMLCanvasElement, listeners: OffscreenPageListeners): void
  detach(browserPageId: string): void
  setViewport(browserPageId: string, viewport: OffscreenPageViewport): void
  input(browserPageId: string, input: OffscreenPageUserInput): void
  command(browserPageId: string, command: OffscreenPageCommand): void
  focus(browserPageId: string): void
  /** Whether Orca's keyboard focus sits in this page, so main routes page chords to it. */
  setKeyboardFocus(browserPageId: string, focused: boolean): void
  /** `point` is window-client CSS px where the open select's menu should appear. */
  showSelectMenu(browserPageId: string, point: { x: number; y: number }): void
  readCaret(browserPageId: string): Promise<OffscreenPageCaret | null>
  /** Replays a pointer move at `point` (window-client CSS px) so Orca shows a changed tooltip. */
  refreshHover(browserPageId: string, point: { x: number; y: number }): void
  /** Hands OS files dropped at `x`,`y` (page CSS px) to the page, as a <webview> receives them. */
  dropFiles(browserPageId: string, drop: { x: number; y: number; files: File[] }): void
  close(browserPageId: string): void
}

const MAX_DROPPED_FILES = 256

type Attachment = {
  canvas: HTMLCanvasElement
  context: CanvasRenderingContext2D | null
  listeners: OffscreenPageListeners
}

const attachments = new Map<string, Attachment>()
let receiverInstalled = false

function installFrameReceiver(): void {
  if (receiverInstalled) {
    return
  }
  receiverInstalled = true
  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, pageId: unknown) => {
    const attachment = typeof pageId === 'string' ? attachments.get(pageId) : undefined
    if (!attachment) {
      importedSharedTexture.release()
      return
    }
    const frame = importedSharedTexture.getVideoFrame()
    try {
      const { canvas } = attachment
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth
        canvas.height = frame.displayHeight
        attachment.context = null
      }
      attachment.context ??= canvas.getContext('2d', { alpha: false })
      attachment.context?.drawImage(frame, 0, 0)
    } finally {
      frame.close()
      importedSharedTexture.release()
    }
  })
  ipcRenderer.on('offscreen-page:event', (_e, pageId: string, event: OffscreenPageGuestEvent) => {
    attachments.get(pageId)?.listeners.onEvent(event)
  })
  ipcRenderer.on('offscreen-page:cursor', (_e, pageId: string, cursor: string) => {
    attachments.get(pageId)?.listeners.onCursor(cursor)
  })
  ipcRenderer.on('offscreen-page:tooltip-changed', (_e, pageId: string, text: string) => {
    attachments.get(pageId)?.listeners.onTooltip(text)
  })
  ipcRenderer.on(
    'offscreen-page:datalist',
    (_e, pageId: string, datalist: OffscreenPageDatalist | null) => {
      attachments.get(pageId)?.listeners.onDatalist(datalist)
    }
  )
  ipcRenderer.on(
    'offscreen-page:select',
    (_e, pageId: string, anchor: OffscreenPageSelectAnchor) => {
      attachments.get(pageId)?.listeners.onSelect(anchor)
    }
  )
}

export const offscreenPageApi: OffscreenPageApi = {
  create: (args) => ipcRenderer.invoke('offscreenPage:create', args),
  attach(browserPageId, canvas, listeners) {
    installFrameReceiver()
    attachments.set(browserPageId, { canvas, context: null, listeners })
  },
  detach(browserPageId) {
    attachments.delete(browserPageId)
  },
  setViewport: (id, viewport) => ipcRenderer.send('offscreenPage:viewport', id, viewport),
  input: (id, input) => ipcRenderer.send('offscreenPage:input', id, input),
  command: (id, command) => ipcRenderer.send('offscreenPage:command', id, command),
  focus: (id) => ipcRenderer.send('offscreenPage:focus', id),
  setKeyboardFocus: (id, focused) => ipcRenderer.send('offscreenPage:keyboardFocus', id, focused),
  showSelectMenu: (id, point) => ipcRenderer.send('offscreenPage:selectMenu', id, point),
  readCaret: (id) => ipcRenderer.invoke('offscreenPage:caret', id),
  refreshHover: (id, point) => ipcRenderer.send('offscreenPage:refreshHover', id, point),
  dropFiles(id, { x, y, files }) {
    const paths = files
      .slice(0, MAX_DROPPED_FILES)
      .map((file) => webUtils.getPathForFile(file))
      .filter((path) => path.length > 0)
    if (paths.length > 0) {
      ipcRenderer.send('offscreenPage:dropFiles', id, { x, y, files: paths })
    }
  },
  close: (id) => {
    attachments.delete(id)
    ipcRenderer.send('offscreenPage:close', id)
  }
}
