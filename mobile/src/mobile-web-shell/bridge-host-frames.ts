import { BRIDGE_PROTOCOL_VERSION, type BridgeHostMessage } from './bridge/bridge-envelope'
import { captureBridgeError } from './bridge/bridge-error-capture'
import type { BridgeHostDiagnostic } from './bridge-host-contract'

/** One host's outbound frames: what it posts, and whether the post landed. */
export type BridgeHostFrames = {
  /**
   * Posts one frame and answers whether the page received it.
   *
   * True only once `post` has resolved. A caller that spends something on delivery — the screen
   * clears a one-shot route param on it — must not act on the handover: `post` crosses to the
   * native view and a view that is gone rejects, which used to be reported a turn later as a
   * diagnostic while the caller had already treated the frame as delivered.
   */
  readonly postJson: (json: string) => Promise<boolean>
  /** Fire-and-forget, for every frame nobody waits on. */
  readonly sendJson: (json: string) => void
  readonly send: (frame: BridgeHostMessage) => void
  readonly sendError: (id: string, error: unknown) => void
}

/**
 * The send half of a host, split out because `bridge-host.ts` sits at its line cap.
 *
 * `isOpen` rather than two flags: between documents the view still exists and still accepts posts,
 * which is exactly why it is asked — a frame sent then lands in the next document before it has
 * said `ready` — and a disposed host can neither post nor refuse.
 */
export function createBridgeHostFrames(args: {
  post: (json: string) => Promise<void>
  isOpen: () => boolean
  onDiagnostic?: (diagnostic: BridgeHostDiagnostic) => void
}): BridgeHostFrames {
  // Once per session, for the reason a failing post is: a page nudging a broken listener nudges it
  // again on every foreground, and a line per frame buries the one that says why.
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
      // A `post` that throws where it should reject would escape into the client's own
      // state-change fan-out, which is what sends the `state` frame, and take the other listeners
      // down with it. Awaited here, so both shapes land in the same catch.
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
    // Every value in a host frame has already been serialized by whoever produced it — a reply by
    // `splitBridgeReply`, an error `code` by the capture's round trip — so this cannot throw.
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
