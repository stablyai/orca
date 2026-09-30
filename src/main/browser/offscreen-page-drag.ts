import type { WebContents } from 'electron'
import type { OffscreenPageFileDrop } from '../../shared/offscreen-page-protocol'
import type { OffscreenPageCdpSession } from './offscreen-page-cdp-session'
import type { OffscreenPageFrames } from './offscreen-page-frames'

type DragData = Record<string, unknown>

export type OffscreenPageDragBridge = {
  /**
   * Replays OS files dropped on the host element. File paths only exist at drop time, so the page
   * sees enter, over and drop together at the drop point.
   */
  dropFiles(drop: OffscreenPageFileDrop): Promise<void>
  dispose(): void
}

/**
 * Carries HTML drag-and-drop for an offscreen page. Chromium starts a drag by handing it to the
 * native view, and an offscreen page has none, so the drag would die at dragstart. With drag
 * interception on, Chromium hands the drag data to Orca instead, and later pointer input, from the
 * user or an agent alike, is replayed as drag events until the button comes up.
 */
export function createOffscreenPageDragBridge(
  session: OffscreenPageCdpSession,
  frames: OffscreenPageFrames,
  contents: WebContents
): OffscreenPageDragBridge {
  let drag: { data: DragData; entered: boolean } | null = null
  // The frame target the drag is over, so leaving it can be told apart from moving within it.
  let over: string | undefined

  /** Sends a drag event, at a main-frame CSS px point, to the frame under that point. */
  const dispatch = (type: string, x: number, y: number, data: DragData): Promise<unknown> =>
    frames
      .inOrder(async () => {
        const point = await frames.locate(x, y)
        const send = (eventType: string, at: { x: number; y: number }, sessionId?: string) =>
          session.send(
            'Input.dispatchDragEvent',
            { type: eventType, x: at.x, y: at.y, data },
            sessionId
          )
        if (type !== 'dragEnter' && point.sessionId !== over) {
          // Why: Blink hears a drag leave its frame only as a drag over a point outside it.
          void send('dragOver', { x: -1, y: -1 }, over).catch(() => {})
          if (type === 'dragOver') {
            void send('dragEnter', point, point.sessionId).catch(() => {})
          }
        }
        over = point.sessionId
        return { reply: send(type, point, point.sessionId) }
      })
      .catch(() => {})
  const onPointer = (type: 'move' | 'up' | 'cancel', x: number, y: number): void => {
    if (!drag) {
      return
    }
    const { data } = drag
    if (type === 'move') {
      if (!drag.entered) {
        drag.entered = true
        void dispatch('dragEnter', x, y, data)
      }
      void dispatch('dragOver', x, y, data)
      return
    }
    drag = null
    void dispatch(type === 'up' ? 'drop' : 'dragCancel', x, y, data)
  }
  const stopMessages = session.onMessage((method, params) => {
    if (method === 'Input.dragIntercepted' && isRecord(params.data)) {
      drag = { data: params.data, entered: false }
    }
  })
  // Input to the page's own widget, from the user or an agent; its points are DIPs.
  const onInput = (_event: unknown, input: unknown): void => {
    if (!isRecord(input) || typeof input.type !== 'string') {
      return
    }
    const zoom = contents.getZoomFactor()
    const x = (typeof input.x === 'number' ? input.x : 0) / zoom
    const y = (typeof input.y === 'number' ? input.y : 0) / zoom
    if (input.type === 'mouseMove' || input.type === 'mouseUp') {
      onPointer(input.type === 'mouseMove' ? 'move' : 'up', x, y)
    } else if (
      input.type === 'mouseLeave' ||
      (input.type === 'rawKeyDown' && input.key === 'Escape')
    ) {
      onPointer('cancel', x, y)
    }
  }
  contents.on('input-event', onInput)
  // Input Orca sent into an out-of-process iframe, which that widget alone sees.
  const stopChildMouse = frames.onChildMouse((params) => {
    if (params.type === 'mouseMoved' || params.type === 'mouseReleased') {
      onPointer(params.type === 'mouseMoved' ? 'move' : 'up', params.x, params.y)
    }
  })

  return {
    async dropFiles(drop) {
      const zoom = contents.getZoomFactor()
      const [x, y] = [drop.x / zoom, drop.y / zoom]
      // Why mask 1 (copy): that is what an OS file drop offers a page.
      const data = { items: [], files: drop.files, dragOperationsMask: 1 }
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await dispatch(type, x, y, data)
      }
    },
    dispose() {
      drag = null
      stopMessages()
      stopChildMouse()
      if (!contents.isDestroyed()) {
        contents.off('input-event', onInput)
      }
    }
  }
}

export const OFFSCREEN_PAGE_DRAG_SETUP = [['Input.setInterceptDrags', { enabled: true }]] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
