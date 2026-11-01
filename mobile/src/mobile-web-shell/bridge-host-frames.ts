import { BRIDGE_PROTOCOL_VERSION, type BridgeHostMessage } from './bridge/bridge-envelope'
import { captureBridgeError } from './bridge/bridge-error-capture'
import type { BridgeHostDiagnostic } from './bridge-host-contract'

export type BridgeHostFrames = {
  // True only after native post resolves; a vanished view rejects. Resolution proves handoff, not page receipt or one-shot consumption.
  readonly postJson: (json: string) => Promise<boolean>
  readonly sendJson: (json: string) => void
  readonly send: (frame: BridgeHostMessage) => void
  readonly sendError: (id: string, error: unknown) => void
}

// Check document openness, not just view existence: posts between close and ready could reach the next document; disposed hosts cannot post.
export function createBridgeHostFrames(args: {
  post: (json: string) => Promise<void>
  isOpen: () => boolean
  onDiagnostic?: (diagnostic: BridgeHostDiagnostic) => void
}): BridgeHostFrames {
  // Report once so repeated foreground/frame failures cannot bury the first cause.
  let postFailureReported = false

  function reportPostFailure(error: unknown): void {
    if (postFailureReported) {
      return
    }
    postFailureReported = true
    args.onDiagnostic?.({ kind: 'post-failed', error })
  }

  async function postJson(json: string): Promise<boolean> {
    if (!args.isOpen()) {
      return false
    }
    try {
      // Await inside try so synchronous throws and rejected posts both stay out of the client’s state-change fan-out.
      await args.post(json)
      return true
    } catch (error) {
      reportPostFailure(error)
      return false
    }
  }

  function sendJson(json: string): void {
    void postJson(json)
  }

  return {
    postJson,
    sendJson,
    // Frame producers already serialized values or captured errors, so no cyclic/unserializable values remain.
    send: (frame) => {
      sendJson(JSON.stringify(frame))
    },
    sendError: (id, error) => {
      sendJson(
        JSON.stringify({
          v: BRIDGE_PROTOCOL_VERSION,
          type: 'error',
          id,
          error: captureBridgeError(error)
        })
      )
    }
  }
}
