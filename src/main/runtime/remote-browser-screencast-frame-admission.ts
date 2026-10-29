import { isRemoteRuntimeBinaryFrameWithinLimit } from '../../shared/remote-runtime/remote-runtime-memory-limits'
import type { RpcBinarySender } from './rpc/rpc-binary-sender'

/** 'backlogged': a live socket skipped the frame; 'refused': the transport would not take it. */
export type ScreencastFrameSendOutcome = 'handled' | 'backlogged' | 'refused'

// Drop oversize frames as handled: retrying the same refused payload would close E2EE with 1013 forever.
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
