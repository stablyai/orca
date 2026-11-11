import { isRemoteRuntimeBinaryFrameWithinLimit } from '../../../../shared/remote-runtime/remote-runtime-memory-limits'
import type { RpcBinarySender } from '../../rpc/rpc-binary-sender'

/** 'dropped': oversize, never sent or retried; 'backlogged': a live socket skipped the frame;
 * 'refused': the transport would not take it. */
export type ScreencastFrameSendOutcome = 'handled' | 'dropped' | 'backlogged' | 'refused'

// Never send an oversize frame: E2EE would close with 1013 on it and on every retry.
export function sendRemoteBrowserScreencastFrame(
  sendBinary: RpcBinarySender,
  bytes: Uint8Array<ArrayBufferLike>
): ScreencastFrameSendOutcome {
  if (!isRemoteRuntimeBinaryFrameWithinLimit(bytes)) {
    return 'dropped'
  }
  const sent = sendBinary(bytes, { dropWhenBacklogged: true })
  return sent === 'backlogged' ? 'backlogged' : sent === false ? 'refused' : 'handled'
}
