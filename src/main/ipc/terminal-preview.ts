import { ipcMain, type WebContents } from 'electron'
import type {
  TerminalPreviewConnectResult,
  TerminalPreviewSnapshot
} from '../../shared/terminal-preview'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { isDashboardPopoutRenderer } from '../window/dashboard-popout-window'
import {
  TERMINAL_PREVIEW_OUTPUT_BATCH_MAX_BYTES,
  TerminalPreviewOutputStream
} from './terminal-preview-output-stream'

const PREVIEW_ID_MAX_LENGTH = 4096

function isValidPtyId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= PREVIEW_ID_MAX_LENGTH
}

/** Pop-out terminal transport with an atomic snapshot/live boundary. */
export function registerTerminalPreviewHandlers(runtime: OrcaRuntimeService): void {
  ipcMain.removeHandler('terminalPreview:connect')
  ipcMain.removeHandler('terminalPreview:unsubscribe')
  ipcMain.removeHandler('terminalPreview:input')
  ipcMain.removeHandler('terminalPreview:ack')

  const subscriptionsByContents = new Map<number, Map<string, TerminalPreviewOutputStream>>()

  const removeSubscription = (subscription: TerminalPreviewOutputStream): void => {
    const perPty = subscriptionsByContents.get(subscription.contents.id)
    if (perPty?.get(subscription.ptyId) === subscription) {
      perPty.delete(subscription.ptyId)
    }
  }

  const disposeContents = (contentsId: number): void => {
    const perPty = subscriptionsByContents.get(contentsId)
    if (!perPty) {
      return
    }
    for (const subscription of perPty.values()) {
      subscription.dispose()
    }
    subscriptionsByContents.delete(contentsId)
  }

  const subscriptionsFor = (contents: WebContents): Map<string, TerminalPreviewOutputStream> => {
    let perPty = subscriptionsByContents.get(contents.id)
    if (!perPty) {
      perPty = new Map()
      subscriptionsByContents.set(contents.id, perPty)
      contents.once('destroyed', () => disposeContents(contents.id))
    }
    return perPty
  }

  ipcMain.handle(
    'terminalPreview:connect',
    async (
      event,
      args: { ptyId?: unknown; opts?: { scrollbackRows?: unknown } }
    ): Promise<TerminalPreviewConnectResult> => {
      if (!isDashboardPopoutRenderer(event.sender) || !isValidPtyId(args?.ptyId)) {
        return { snapshot: null, replay: [] }
      }
      const ptyId = args.ptyId
      const perPty = subscriptionsFor(event.sender)
      perPty.get(ptyId)?.dispose()

      const subscription = new TerminalPreviewOutputStream(
        event.sender,
        ptyId,
        runtime.registerRawTerminalViewSubscriber(ptyId),
        removeSubscription
      )
      subscription.setDataSubscription(
        runtime.subscribeToTerminalData(ptyId, (data, meta) => subscription.append(data, meta))
      )
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
            // Why: never replay a tail with a silently missing middle; the renderer keeps its old frame while reconnecting.
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
        // Why: a failed lookup has no future live boundary; release raw presence even if the renderer never invokes unsubscribe.
        subscription.dispose()
        return { snapshot: null, replay: [] }
      }

      const replay = subscription.completeSnapshot(snapshot.seq)
      if (resyncRequired) {
        // Why: no live writes may outlive this stream and acknowledge bytes against its replacement.
        subscription.pauseForReconnect()
      }
      return { snapshot, replay, ...(resyncRequired ? { resyncRequired: true } : {}) }
    }
  )

  ipcMain.handle(
    'terminalPreview:input',
    (event, args: { ptyId?: unknown; data?: unknown }): Promise<boolean> => {
      if (
        !isDashboardPopoutRenderer(event.sender) ||
        !isValidPtyId(args?.ptyId) ||
        typeof args.data !== 'string'
      ) {
        return Promise.resolve(false)
      }
      return runtime.writeTerminalPreviewInput(args.ptyId, args.data)
    }
  )

  ipcMain.handle(
    'terminalPreview:ack',
    (event, args: { ptyId?: unknown; bytes?: unknown }): void => {
      if (
        !isDashboardPopoutRenderer(event.sender) ||
        !isValidPtyId(args?.ptyId) ||
        typeof args.bytes !== 'number' ||
        !Number.isFinite(args.bytes) ||
        args.bytes <= 0 ||
        args.bytes > TERMINAL_PREVIEW_OUTPUT_BATCH_MAX_BYTES
      ) {
        return
      }
      subscriptionsByContents.get(event.sender.id)?.get(args.ptyId)?.acknowledge(args.bytes)
    }
  )

  ipcMain.handle('terminalPreview:unsubscribe', (event, args: { ptyId?: unknown }): void => {
    if (!isDashboardPopoutRenderer(event.sender) || !isValidPtyId(args?.ptyId)) {
      return
    }
    subscriptionsByContents.get(event.sender.id)?.get(args.ptyId)?.dispose()
  })
}
