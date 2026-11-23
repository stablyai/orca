import type { WebFrame } from 'electron'
import {
  GRAB_EXECUTION_REQUEST,
  GRAB_EXECUTION_REPORT,
  type GrabExecutionRequest,
  type GrabExecutionResult
} from '../../../shared/browser/element-grab/grab-execution-protocol'
import {
  createBrowserGuestPickerAuthority,
  type BrowserGuestPickerAuthority
} from './browser-guest-picker-authority'
import { waitForGuestPaint } from './browser-guest-paint'

type Control = (action: string, value?: unknown) => unknown
type Overlay = { id: string; control: Control; host: Element | null }
type HeldPick = { id: string; control: Control; overlayId: string | null; element: Element | null }

const asControl = (value: unknown): Control | null => {
  if (typeof value !== 'function') {
    return null
  }
  const returned = value
  return (action, argument) => returned(action, argument)
}

/**
 * Captured functions stay private to this document's preload, never in a page bridge or IPC payload.
 * Where the DOM is available, the picked element and the overlay's removal are judged through this
 * isolated world's own references, so page code cannot decide either.
 */
export function installBrowserGuestExecution(
  port: {
    on: (channel: string, listener: (payload: GrabExecutionRequest) => void) => void
    send: (channel: string, payload: unknown) => void
  },
  frame: Pick<WebFrame, 'executeJavaScript' | 'executeJavaScriptInIsolatedWorld'>,
  retireNativePolicy: () => void = () => {},
  authority: BrowserGuestPickerAuthority | null = createBrowserGuestPickerAuthority()
): void {
  const documentId = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-')
  const occupied = new Set<string>()
  const completed = new Map<string, { id: string; result: GrabExecutionResult }>()
  let overlay: Overlay | null = null
  let pendingOverlay: string | null = null
  let retiredOverlay: string | null = null
  // Hosts this preload tore down; a clean verdict needs every one of them really detached.
  const retiredHosts = new Set<Element>()
  const picks: Partial<Record<'held' | 'hover', HeldPick>> = {}
  let capture: { id: string; restore: () => void } | null = null
  const restore = (id: string): void => {
    if (capture?.id === id) {
      const saved = capture
      capture = null
      saved.restore()
    }
  }
  const tearDown = (owned: Overlay): boolean => {
    retireNativePolicy()
    if (owned.host) {
      retiredHosts.add(owned.host)
    }
    return owned.control('teardown') === true
  }
  const ownedHostsRemoved = (): boolean => {
    if (!authority) {
      return true
    }
    for (const host of retiredHosts) {
      if (!authority.hostRemoved(host)) {
        return false
      }
      retiredHosts.delete(host)
    }
    return true
  }
  const execute = (request: Extract<GrabExecutionRequest, { kind: 'execute' }>) =>
    request.worldId === 0
      ? frame.executeJavaScript(request.code)
      : frame.executeJavaScriptInIsolatedWorld(request.worldId, [{ code: request.code }])
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
        tearDown(overlay)
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
      const selectedOverlay = overlay
      try {
        let value: unknown
        if (request.clean) {
          retireNativePolicy()
          let removed = true
          if (overlay) {
            removed = tearDown(overlay)
            overlay = null
          }
          const painted = await waitForGuestPaint()
          // Positive only when the owned overlay is verifiably gone from this document.
          value = removed && ownedHostsRemoved() && painted
        } else if (request.pick) {
          value = await runPickOperation(request)
          if (value === undefined) {
            return
          }
        } else if (request.overlayAction) {
          const { action } = request.overlayAction
          if (!selectedOverlay) {
            if (action === 'awaitClick') {
              throw new Error('Grab not armed')
            }
            value = action === 'extractHover' ? null : true
          } else {
            const argument =
              'argument' in request.overlayAction ? request.overlayAction.argument : undefined
            value = await selectedOverlay.control(action, argument)
          }
        } else if (request.overlayControl) {
          const armed = authority
            ? await authority.observeArm(() => execute(request))
            : { value: await execute(request), host: null }
          const control = asControl(armed.value)
          if (!control) {
            throw new Error('Missing overlay control')
          }
          const next: Overlay = { id: request.id, control, host: armed.host }
          if (retiredOverlay === request.id || (authority && !armed.host)) {
            tearDown(next)
            value = false
          } else {
            if (overlay) {
              tearDown(overlay)
            }
            overlay = next
            value = true
          }
        } else {
          value = await execute(request)
        }
        if (request.capturePick && typeof value === 'function') {
          value = capturePick(request.id, request.capturePick, asControl(value), selectedOverlay)
        }
        if (
          request.capturePick &&
          value &&
          typeof value === 'object' &&
          '__orcaCancelled' in value &&
          value.__orcaCancelled === true &&
          !('__orcaPreserveOverlay' in value && value.__orcaPreserveOverlay === true) &&
          overlay === selectedOverlay
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

    function capturePick(
      requestId: string,
      kind: 'held' | 'hover',
      control: Control | null,
      owner: Overlay | null
    ): unknown {
      const result = control?.('payload')
      if (!control || !result || typeof result !== 'object' || !('payload' in result)) {
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
      const marker =
        'capturedAt' in source.page && typeof source.page.capturedAt === 'string'
          ? source.page.capturedAt
          : ''
      // The element is the one under the trusted pointer, never the page world's claim.
      const element = authority
        ? authority.resolvePick(owner?.host ?? null, kind === 'held' ? marker : null)
        : null
      if (authority && !element) {
        return kind === 'held' ? { __orcaCancelled: true } : null
      }
      const id = `${documentId}-${requestId}`
      picks[kind] = { id, control, overlayId: owner?.id ?? null, element }
      const payload = { ...source, page: { ...source.page, selectionId: id } }
      return 'contextMenu' in result && result.contextMenu === true
        ? { __orcaContextMenu: true, payload }
        : payload
    }

    /** Undefined when this function already answered. */
    async function runPickOperation(
      pickRequest: Extract<GrabExecutionRequest, { kind: 'execute' }>
    ): Promise<unknown> {
      const operation = pickRequest.pick
      const pick = Object.values(picks).find((item) => item?.id === operation?.selectionId)
      if (!operation || !pick) {
        return false
      }
      if (
        operation.operation !== 'present' &&
        (!pick.overlayId || pick.overlayId !== overlay?.id)
      ) {
        return false
      }
      const element = pick.element
      if (operation.operation === 'present') {
        return element && authority ? authority.present(element) : pick.control('present')
      }
      if (operation.operation === 'snapshot') {
        return element && authority ? authority.snapshot(element) : pick.control('snapshot')
      }
      if (capture || !operation.captureId) {
        answer({ ok: false })
        return undefined
      }
      const id = operation.captureId
      const hidden = pick.control('hide', id)
      const snapshot = element && authority ? authority.snapshot(element) : hidden
      if (!hidden || !snapshot) {
        if (hidden) {
          pick.control('restore', id)
        }
        return false
      }
      capture = { id, restore: () => pick.control('restore', id) }
      // These timers belong to the isolated preload, not the page's replaceable globals.
      const painted = await waitForGuestPaint()
      if (!painted || capture?.id !== id || Date.now() > pickRequest.expiresAt) {
        restore(id)
        answer({ ok: false })
        return undefined
      }
      return snapshot
    }
  })
}
