import type { WebFrame } from 'electron'
import {
  GRAB_EXECUTION_REQUEST,
  GRAB_EXECUTION_REPORT,
  type GrabExecutionRequest,
  type GrabExecutionResult
} from '../../../shared/browser/element-grab/grab-execution-protocol'

type Control = (action: string, value?: unknown) => unknown

/** Hidden guests can miss paint; retire their queued frame on either outcome. */
function waitForGuestPaint(): Promise<boolean> {
  return new Promise((resolve) => {
    let frame = 0
    let done = false
    const finish = (painted: boolean): void => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      resolve(painted)
    }
    const timer = setTimeout(() => finish(false), 500)
    try {
      frame = requestAnimationFrame(() => {
        if (!done) {
          frame = requestAnimationFrame(() => finish(true))
        }
      })
    } catch {
      finish(false)
    }
  })
}

/** Captured functions stay private to this document's preload, never in a page bridge or IPC payload. */
export function installBrowserGuestExecution(
  port: {
    on: (channel: string, listener: (payload: GrabExecutionRequest) => void) => void
    send: (channel: string, payload: unknown) => void
  },
  frame: Pick<WebFrame, 'executeJavaScript' | 'executeJavaScriptInIsolatedWorld'>,
  retireNativePolicy: () => void = () => {}
): void {
  const documentId = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-')
  const occupied = new Set<string>()
  const completed = new Map<string, { id: string; result: GrabExecutionResult }>()
  let overlay: { id: string; control: Control } | null = null
  let pendingOverlay: string | null = null
  let retiredOverlay: string | null = null
  const picks: Partial<
    Record<'held' | 'hover', { id: string; control: Control; overlayId: string | null }>
  > = {}
  let capture: { id: string; restore: () => void } | null = null
  const restore = (id: string): void => {
    if (capture?.id === id) {
      const saved = capture
      capture = null
      saved.restore()
    }
  }
  port.on(GRAB_EXECUTION_REQUEST, (request) => {
    if (request.kind === 'hello') {
      const cached = [...completed.values()].find((item) => item.id === request.id)
      port.send(
        GRAB_EXECUTION_REPORT,
        cached
          ? { id: request.id, documentId, result: cached.result }
          : { id: request.id, documentId, ready: true }
      )
      return
    }
    if (request.documentId !== documentId) {
      return
    }
    if (request.kind === 'restoreCapture') {
      restore(request.captureId)
      return
    }
    if (request.kind === 'retire') {
      if (pendingOverlay === request.overlayId) {
        retiredOverlay = request.overlayId
      }
      if (overlay?.id === request.overlayId) {
        retireNativePolicy()
        overlay.control('teardown')
        overlay = null
      }
      return
    }
    const answer = (result: GrabExecutionResult): void => {
      completed.set(request.lane, { id: request.id, result })
      port.send(GRAB_EXECUTION_REPORT, { id: request.id, documentId, result })
    }
    if (Date.now() > request.expiresAt || occupied.has(request.lane)) {
      answer({ ok: false })
      return
    }
    occupied.add(request.lane)
    if (request.overlayControl) {
      pendingOverlay = request.id
    }
    void (async () => {
      const selectedOverlayId = overlay?.id ?? null
      try {
        let value: unknown
        if (request.clean) {
          retireNativePolicy()
          if (overlay) {
            overlay.control('teardown')
            overlay = null
          }
          value = await waitForGuestPaint()
        } else if (request.pick) {
          const pick = Object.values(picks).find((item) => item?.id === request.pick?.selectionId)
          if (!pick) {
            answer({ ok: true, value: false })
            return
          }
          if (
            request.pick.operation !== 'present' &&
            (!pick.overlayId || pick.overlayId !== overlay?.id)
          ) {
            answer({ ok: true, value: false })
            return
          }
          if (request.pick.operation === 'prepareCapture') {
            if (capture || !request.pick.captureId) {
              answer({ ok: false })
              return
            }
            const id = request.pick.captureId
            const snapshot = pick.control('hide', id)
            if (!snapshot) {
              answer({ ok: true, value: false })
              return
            }
            capture = {
              id,
              restore: () => {
                pick.control('restore', id)
              }
            }
            // These timers belong to the isolated preload, not the page's replaceable globals.
            const painted = await waitForGuestPaint()
            if (!painted || capture?.id !== id || Date.now() > request.expiresAt) {
              restore(id)
              answer({ ok: false })
              return
            }
            value = snapshot
          } else {
            value = pick.control(request.pick.operation)
          }
        } else {
          value = await (request.worldId === 0
            ? frame.executeJavaScript(request.code)
            : frame.executeJavaScriptInIsolatedWorld(request.worldId, [{ code: request.code }]))
          if (request.overlayControl) {
            if (typeof value !== 'function') {
              throw new Error('Missing overlay control')
            }
            const returnedControl = value
            const control: Control = (action, argument) => returnedControl(action, argument)
            if (retiredOverlay === request.id) {
              retireNativePolicy()
              control('teardown')
              value = false
            } else {
              overlay = { id: request.id, control }
              value = true
            }
          } else if (request.capturePick && typeof value === 'function') {
            const returnedControl = value
            const control: Control = (action, argument) => returnedControl(action, argument)
            const result = control('payload')
            if (!result || typeof result !== 'object' || !('payload' in result)) {
              throw new Error('Missing selection payload')
            }
            const source = result.payload
            if (
              !source ||
              typeof source !== 'object' ||
              !('page' in source) ||
              !source.page ||
              typeof source.page !== 'object'
            ) {
              throw new Error('Invalid selection payload')
            }
            const id = `${documentId}-${request.id}`
            picks[request.capturePick] = { id, control, overlayId: selectedOverlayId }
            const payload = { ...source, page: { ...source.page, selectionId: id } }
            value =
              'contextMenu' in result && result.contextMenu === true
                ? { __orcaContextMenu: true, payload }
                : payload
          }
        }
        if (
          request.capturePick &&
          value &&
          typeof value === 'object' &&
          '__orcaCancelled' in value &&
          value.__orcaCancelled === true &&
          !('__orcaPreserveOverlay' in value && value.__orcaPreserveOverlay === true) &&
          overlay?.id === selectedOverlayId
        ) {
          retireNativePolicy()
        }
        answer({ ok: true, value })
      } catch {
        answer({ ok: false })
      } finally {
        occupied.delete(request.lane)
        if (pendingOverlay === request.id) {
          pendingOverlay = null
        }
        if (retiredOverlay === request.id) {
          retiredOverlay = null
        }
      }
    })()
  })
}
