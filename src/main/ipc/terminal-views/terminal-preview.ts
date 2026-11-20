import {
  type AppDocument,
  type AppCaller,
  removeAppHandler,
  registerAppHandler,
  appDocumentFor
} from '../app-registry/app-handler-registry'

import type {
  TerminalPreviewConnectResult,
  TerminalPreviewSnapshot
} from '../../../shared/terminal/replay/terminal-preview'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'

import { abortWhenRendererGone } from '../renderer-requests/renderer-lifetime-abort'
import {
  TERMINAL_PREVIEW_OUTPUT_BATCH_MAX_BYTES,
  TerminalPreviewOutputStream
} from './terminal-preview-output-stream'

const PREVIEW_ID_MAX_LENGTH = 4096

function isValidPtyId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= PREVIEW_ID_MAX_LENGTH
}

// Both popout and main-renderer overlay host previews; trusted UI already has ordinary PTY access.
function isTerminalPreviewRenderer(caller: AppCaller): boolean {
  return caller.role === 'main' || caller.role === 'dashboard-popout'
}
/** Pop-out terminal transport with an atomic snapshot/live boundary. */
export function registerTerminalPreviewHandlers(runtime: OrcaRuntimeService): void {
  removeAppHandler('terminalPreview:connect')
  removeAppHandler('terminalPreview:unsubscribe')
  removeAppHandler('terminalPreview:input')
  removeAppHandler('terminalPreview:ack')
  removeAppHandler('terminalPreview:fit')

  const subscriptionsByContents = new Map<number, Map<string, TerminalPreviewOutputStream>>()
  // Unsubscribe or renderer document retirement releases the host pane's grid claim.
  const fitClaimsByContents = new Map<number, Map<string, symbol>>()
  const rendererLifetimes = new Map<number, ReturnType<typeof abortWhenRendererGone>>()

  const previewViewerKey = (contentsId: number): string => `dashboard-popout:${contentsId}`

  const releaseFitClaim = (contentsId: number, ptyId: string): void => {
    const claimed = fitClaimsByContents.get(contentsId)
    if (!claimed?.delete(ptyId)) {
      return
    }
    if (claimed.size === 0) {
      fitClaimsByContents.delete(contentsId)
    }
    void runtime
      .unregisterRemoteDesktopViewer(ptyId, previewViewerKey(contentsId))
      .catch(() => undefined)
  }

  const removeSubscription = (subscription: TerminalPreviewOutputStream): void => {
    const perPty = subscriptionsByContents.get(subscription.contents.id)
    if (perPty?.get(subscription.ptyId) === subscription) {
      perPty.delete(subscription.ptyId)
    }
  }

  const disposeContents = (contentsId: number): void => {
    const lifetime = rendererLifetimes.get(contentsId)
    rendererLifetimes.delete(contentsId)
    lifetime?.dispose()
    const perPty = subscriptionsByContents.get(contentsId)
    if (perPty) {
      for (const subscription of perPty.values()) {
        subscription.dispose()
      }
      subscriptionsByContents.delete(contentsId)
    }
    for (const ptyId of fitClaimsByContents.get(contentsId)?.keys() ?? []) {
      releaseFitClaim(contentsId, ptyId)
    }
  }

  const subscriptionsFor = (contents: AppDocument): Map<string, TerminalPreviewOutputStream> => {
    let perPty = subscriptionsByContents.get(contents.id)
    if (!perPty) {
      perPty = new Map()
      subscriptionsByContents.set(contents.id, perPty)
      const lifetime = abortWhenRendererGone(contents)
      rendererLifetimes.set(contents.id, lifetime)
      lifetime.signal.addEventListener('abort', () => disposeContents(contents.id), { once: true })
    }
    return perPty
  }

  registerAppHandler(
    'terminalPreview:connect',
    async (
      event,
      args: { ptyId?: unknown; opts?: { scrollbackRows?: unknown } }
    ): Promise<TerminalPreviewConnectResult> => {
      if (!isTerminalPreviewRenderer(event) || !isValidPtyId(args?.ptyId)) {
        return { snapshot: null, replay: [] }
      }
      const ptyId = args.ptyId
      const perPty = subscriptionsFor(appDocumentFor(event))
      perPty.get(ptyId)?.dispose()

      const subscription = new TerminalPreviewOutputStream(
        appDocumentFor(event),
        ptyId,
        runtime.registerRawTerminalViewSubscriber(ptyId),
        removeSubscription
      )
      const unsubscribeData = runtime.subscribeToTerminalData(ptyId, (data, meta) =>
        subscription.append(data, meta)
      )
      let previewSize = runtime.getTerminalSize(ptyId)
      // Grid changes invalidate parsing at the old width; reconnect from a new authoritative snapshot.
      const unsubscribeResize = runtime.subscribeToTerminalResize(ptyId, (event) => {
        if (previewSize?.cols === event.cols && previewSize.rows === event.rows) {
          return
        }
        previewSize = { cols: event.cols, rows: event.rows }
        subscription.requestResync()
      })
      subscription.setDataSubscription(() => {
        unsubscribeData()
        unsubscribeResize()
      })
      perPty.set(ptyId, subscription)

      const requestedRows = args.opts?.scrollbackRows
      const scrollbackRows =
        typeof requestedRows === 'number' && Number.isFinite(requestedRows)
          ? Math.max(0, Math.min(1000, Math.floor(requestedRows)))
          : undefined
      let snapshot: TerminalPreviewSnapshot | null
      let resyncRequired = false
      try {
        snapshot = await runtime.serializeTerminalBuffer(ptyId, { scrollbackRows })
        if (subscription.consumeInitialOverflow() && !subscription.disposed) {
          snapshot = await runtime.serializeTerminalBuffer(ptyId, { scrollbackRows })
          if (subscription.consumeInitialOverflow()) {
            // Never replay across an output gap; reconnect while retaining the previous frame.
            resyncRequired = true
          }
        }
      } catch {
        subscription.dispose()
        return { snapshot: null, replay: [] }
      }
      if (subscription.disposed) {
        return { snapshot: null, replay: [] }
      }
      if (!snapshot) {
        // Failed lookup has no future live boundary; release presence without waiting for unsubscribe.
        subscription.dispose()
        return { snapshot: null, replay: [] }
      }
      previewSize = { cols: snapshot.cols, rows: snapshot.rows }

      const replay = subscription.completeSnapshot(snapshot.seq)
      if (resyncRequired) {
        // Retired streams must not acknowledge bytes belonging to their replacement.
        subscription.pauseForReconnect()
      }
      return { snapshot, replay, ...(resyncRequired ? { resyncRequired: true } : {}) }
    }
  )

  registerAppHandler(
    'terminalPreview:input',
    (event, args: { ptyId?: unknown; data?: unknown }): Promise<boolean> => {
      if (
        !isTerminalPreviewRenderer(event) ||
        !isValidPtyId(args?.ptyId) ||
        typeof args.data !== 'string'
      ) {
        return Promise.resolve(false)
      }
      return runtime.writeTerminalPreviewInput(args.ptyId, args.data)
    }
  )

  registerAppHandler(
    'terminalPreview:ack',
    (event, args: { ptyId?: unknown; bytes?: unknown }): void => {
      if (
        !isTerminalPreviewRenderer(event) ||
        !isValidPtyId(args?.ptyId) ||
        typeof args.bytes !== 'number' ||
        !Number.isFinite(args.bytes) ||
        args.bytes <= 0 ||
        args.bytes > TERMINAL_PREVIEW_OUTPUT_BATCH_MAX_BYTES
      ) {
        return
      }
      subscriptionsByContents
        .get(appDocumentFor(event).id)
        ?.get(args.ptyId)
        ?.acknowledge(args.bytes)
    }
  )

  // Return effective viewer-claimed size so the renderer can scale when phone priority prevents fitting.
  registerAppHandler(
    'terminalPreview:fit',
    async (
      event,
      args: { ptyId?: unknown; cols?: unknown; rows?: unknown }
    ): Promise<{ cols: number; rows: number } | null> => {
      if (
        !isTerminalPreviewRenderer(event) ||
        !isValidPtyId(args?.ptyId) ||
        typeof args.cols !== 'number' ||
        typeof args.rows !== 'number' ||
        !Number.isFinite(args.cols) ||
        !Number.isFinite(args.rows)
      ) {
        return null
      }
      const ptyId = args.ptyId
      // Install destruction cleanup even if this claim outlives its current output stream.
      subscriptionsFor(appDocumentFor(event))
      let claimed = fitClaimsByContents.get(appDocumentFor(event).id)
      if (!claimed) {
        claimed = new Map()
        fitClaimsByContents.set(appDocumentFor(event).id, claimed)
      }
      const claimToken = Symbol('terminal-preview-fit')
      claimed.set(ptyId, claimToken)
      const viewerKey = previewViewerKey(appDocumentFor(event).id)
      try {
        const applied = await runtime.updateRemoteDesktopViewer(
          ptyId,
          viewerKey,
          viewerKey,
          args.cols,
          args.rows
        )
        if (fitClaimsByContents.get(appDocumentFor(event).id)?.get(ptyId) !== claimToken) {
          return null
        }
        if (!applied) {
          releaseFitClaim(appDocumentFor(event).id, ptyId)
          return null
        }
      } catch {
        if (fitClaimsByContents.get(appDocumentFor(event).id)?.get(ptyId) === claimToken) {
          releaseFitClaim(appDocumentFor(event).id, ptyId)
        }
        return null
      }
      return runtime.getTerminalSize(ptyId)
    }
  )

  registerAppHandler('terminalPreview:unsubscribe', (event, args: { ptyId?: unknown }): void => {
    if (!isTerminalPreviewRenderer(event) || !isValidPtyId(args?.ptyId)) {
      return
    }
    subscriptionsByContents.get(appDocumentFor(event).id)?.get(args.ptyId)?.dispose()
    releaseFitClaim(appDocumentFor(event).id, args.ptyId)
  })
}
