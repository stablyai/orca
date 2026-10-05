import {
  createNativeChatInputAction,
  type NativeChatInputAction
} from '../../../src/shared/native-chat-input-action'
import type { MobileNativeChatRpcSender } from './mobile-native-chat-send'

// Why keyed by the connection: the fact describes the host it reaches, and every accepted snapshot
// rewrites it, so a host upgraded or downgraded in place is followed without a reconnect.
const chatInputGuardedByClient = new WeakMap<MobileNativeChatRpcSender, boolean>()

/** Records whether the host behind `client` refuses tagged chat writes after a proven exit. */
export function noteMobileChatInputGuard(
  client: MobileNativeChatRpcSender | null,
  guarded: boolean
): void {
  if (client) {
    chatInputGuardedByClient.set(client, guarded)
  }
}

/** One composer action's id for every write it makes, only for a host that advertises the guard. */
export function createMobileChatInputAction(
  client: MobileNativeChatRpcSender | null
): NativeChatInputAction | undefined {
  return client && chatInputGuardedByClient.get(client) === true
    ? createNativeChatInputAction()
    : undefined
}
