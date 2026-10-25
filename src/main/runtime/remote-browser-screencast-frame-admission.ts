import { isRemoteRuntimeBinaryFrameWithinLimit } from '../../shared/remote-runtime-memory-limits'
import type { RpcBinarySender } from './rpc/rpc-binary-sender'

/** 'backlogged': a live socket skipped the frame; 'refused': the transport would not take it. */
export type ScreencastFrameSendOutcome = 'handled' | 'backlogged' | 'refused'

// Why: the E2EE channel closes the socket (1013) on an over-limit binary frame, and the
// screencast producer reads a refusal as backpressure and retries the identical frame. Reporting
// an over-limit frame as handled drops it so the stream advances instead of retrying forever.
export function sendRemoteBrowserScreencastFrame(
  sendBinary: RpcBinarySender,
  bytes: Uint8Array<ArrayBufferLike>
): ScreencastFrameSendOutcome {
  if (!isRemoteRuntimeBinaryFrameWithinLimit(bytes)) {
    return 'handled'
  }
  const sent = sendBinary(bytes, { dropWhenBacklogged: true })
  return sent === 'backlogged' ? 'backlogged' : sent === false ? 'refused' : 'handled'
}
