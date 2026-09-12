import type { RelayDispatcher, RequestContext } from './dispatcher'
import {
  PTY_OWNERSHIP_CAPTURE_METHODS,
  parsePtyOwnershipCaptureToken
} from '../shared/pty-ownership-capture-wire'
import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from '../shared/pty-ownership-transfer-wire'
import type { beginRelayPtyOwnershipCaptureBoundary } from './relay-pty-ownership-capture-boundary'
import { RelayPtyOwnershipCaptureRegistry } from './relay-pty-ownership-capture-registry'
import type { RelayPtyOwnershipTransferAdapter } from './relay-pty-ownership-transfer-adapter'

/** Register only after explicit runtime opt-in; no production caller enables capture yet. */
export function registerRelayPtyOwnershipCaptureRequests(
  dispatcher: Pick<RelayDispatcher, 'onRequest' | 'onClientDetached'>,
  options: {
    enabled: boolean
    selectCaptureBaseline?: RelayPtyOwnershipTransferAdapter['selectCaptureBaseline']
    recoverCaptureSelection?: RelayPtyOwnershipTransferAdapter['recoverCaptureSelection']
    beginCapture: (
      identity: PtyOwnershipTransferWireIdentity,
      context: RequestContext
    ) => ReturnType<typeof beginRelayPtyOwnershipCaptureBoundary>
  }
): () => void {
  if (!options.enabled) {
    return () => {}
  }
  const registry = new RelayPtyOwnershipCaptureRegistry(
    options.beginCapture,
    options.selectCaptureBaseline
  )
  let disposed = false
  if (options.selectCaptureBaseline && options.recoverCaptureSelection) {
    dispatcher.onRequest(
      PTY_OWNERSHIP_CAPTURE_METHODS.recoverSelection,
      async (params, context) => {
        if (disposed || params.version !== 1) {
          throw new Error('pty_ownership_capture_selection_recovery_unavailable')
        }
        return {
          version: 1,
          baseline: options.recoverCaptureSelection!(params.proof, params.baseline, context)
        }
      }
    )
  }
  const detach = dispatcher.onClientDetached((clientId) => registry.detach(clientId))
  dispatcher.onRequest(PTY_OWNERSHIP_CAPTURE_METHODS.begin, async (params, context) => {
    if (params.version !== 1 || typeof params.requestId !== 'string') {
      throw new Error('pty_ownership_capture_request_invalid')
    }
    const identity = parsePtyOwnershipTransferWireIdentity(params)
    return { version: 1, captureToken: registry.begin(identity, params.requestId, context) }
  })
  dispatcher.onRequest(PTY_OWNERSHIP_CAPTURE_METHODS.inspect, async (params, context) => {
    if (params.version !== 1) {
      throw new Error('pty_ownership_capture_request_invalid')
    }
    return {
      version: 1,
      boundary: registry.inspect(parsePtyOwnershipCaptureToken(params.captureToken), context)
    }
  })
  dispatcher.onRequest(PTY_OWNERSHIP_CAPTURE_METHODS.release, async (params, context) => {
    if (params.version !== 1) {
      throw new Error('pty_ownership_capture_request_invalid')
    }
    registry.release(parsePtyOwnershipCaptureToken(params.captureToken), context)
    return { version: 1, released: true }
  })
  if (options.selectCaptureBaseline) {
    dispatcher.onRequest(PTY_OWNERSHIP_CAPTURE_METHODS.select, async (params, context) => {
      if (params.version !== 1) {
        throw new Error('pty_ownership_capture_request_invalid')
      }
      return {
        version: 1,
        baseline: registry.select(
          parsePtyOwnershipCaptureToken(params.captureToken),
          params.baseline,
          context
        )
      }
    })
  }
  return () => {
    disposed = true
    detach()
    registry.dispose()
  }
}
