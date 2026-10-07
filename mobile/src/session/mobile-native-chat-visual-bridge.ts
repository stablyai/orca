import {
  readNativeChatVisualFrameMessage,
  type NativeChatVisualFrameMessage
} from '../../../src/shared/native-chat-visual-shell'

export type MobileNativeChatVisualBridgeEvent =
  | NativeChatVisualFrameMessage
  /** The visual navigated its frame away from its own document; the host document removed it. */
  | { kind: 'escaped' }

const MAX_BRIDGE_MESSAGE_LENGTH = 8 * 1024
/** A link request is a deliberate tap; the app opens at most one per interval. */
export const MOBILE_NATIVE_CHAT_VISUAL_LINK_INTERVAL_MS = 1_000

/**
 * The app's side of the visual bridge: a message counts only if it carries this frame's token
 * (which only the trusted host document holds) and is one of the two requests a visual may make,
 * from this visual's channel. Everything else, including a well-formed message without the token,
 * is dropped.
 */
export function readMobileNativeChatVisualBridgeMessage(
  raw: unknown,
  token: string,
  channel: string
): MobileNativeChatVisualBridgeEvent | null {
  if (typeof raw !== 'string' || raw.length > MAX_BRIDGE_MESSAGE_LENGTH) {
    return null
  }
  let message: unknown
  try {
    message = JSON.parse(raw)
  } catch {
    return null
  }
  if (
    typeof message !== 'object' ||
    message === null ||
    !('token' in message) ||
    message.token !== token ||
    !('kind' in message)
  ) {
    return null
  }
  if (message.kind === 'escaped') {
    return { kind: 'escaped' }
  }
  if (message.kind === 'frame' && 'data' in message) {
    return readNativeChatVisualFrameMessage(message.data, channel)
  }
  return null
}
