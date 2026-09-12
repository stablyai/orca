import type { PtyHandler } from './pty-handler'
import type { RelayDispatcher } from './dispatcher'
import type { RelayPtyOwnershipTransferAdapter } from './relay-pty-ownership-transfer-adapter'
import type { RelayPtySourcePublication } from './relay-pty-source-publication'
import { beginRelayPtyOwnershipCaptureBoundary } from './relay-pty-ownership-capture-boundary'
import { registerRelayPtyOwnershipCaptureRequests } from './relay-pty-ownership-capture-registration'
const installedHandlers = new WeakSet<object>()

/** Capability lifetime follows the installed handlers; rollout remains an explicit caller choice. */
export function installRelayPtyOwnershipCapture(options: {
  enabled: boolean
  enableBaselineSelection?: boolean
  handler: Pick<
    PtyHandler,
    'beginOwnershipTransferCaptureIngress' | 'setOwnershipTransferCaptureEnabled'
  >
  sourcePublication: Readonly<{
    ownershipTransfer: Pick<
      RelayPtySourcePublication['ownershipTransfer'],
      'authorizes' | 'inspectDrainedDelivery'
    >
  }>
  transfer: Pick<
    RelayPtyOwnershipTransferAdapter,
    'inspectPreparedCaptureCursor' | 'retainCaptureBoundary'
  > &
    Partial<
      Pick<RelayPtyOwnershipTransferAdapter, 'selectCaptureBaseline' | 'recoverCaptureSelection'>
    >
  dispatcher: Pick<RelayDispatcher, 'onRequest' | 'onClientDetached'>
}): () => void {
  if (!options.enabled) {
    return () => {}
  }
  if (installedHandlers.has(options.handler)) {
    throw new Error('pty_ownership_capture_already_installed')
  }
  const selectCaptureBaseline = options.enableBaselineSelection
    ? options.transfer.selectCaptureBaseline?.bind(options.transfer)
    : undefined
  if (options.enableBaselineSelection && !selectCaptureBaseline) {
    throw new Error('pty_ownership_capture_selection_unavailable')
  }
  const dispose = registerRelayPtyOwnershipCaptureRequests(options.dispatcher, {
    enabled: true,
    selectCaptureBaseline,
    recoverCaptureSelection: selectCaptureBaseline
      ? options.transfer.recoverCaptureSelection?.bind(options.transfer)
      : undefined,
    beginCapture: (identity, context) =>
      beginRelayPtyOwnershipCaptureBoundary(identity, context, {
        handler: options.handler,
        transfer: options.transfer,
        source: options.sourcePublication.ownershipTransfer
      })
  })
  installedHandlers.add(options.handler)
  try {
    if (selectCaptureBaseline) {
      options.handler.setOwnershipTransferCaptureEnabled(
        true,
        true,
        !!options.transfer.recoverCaptureSelection
      )
    } else {
      options.handler.setOwnershipTransferCaptureEnabled(true)
    }
  } catch (error) {
    installedHandlers.delete(options.handler)
    dispose()
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) {
      return
    }
    disposed = true
    try {
      options.handler.setOwnershipTransferCaptureEnabled(false)
    } finally {
      installedHandlers.delete(options.handler)
      dispose()
    }
  }
}
