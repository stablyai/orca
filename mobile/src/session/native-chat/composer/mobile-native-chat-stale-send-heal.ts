import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../../transport/connection/connection-state'
import {
  healMobileNativeChatStaleInput,
  isMobileNativeChatInputStale
} from './mobile-native-chat-stale-input'

/** Heals a stale paste before a text-only send. Returns an error message when the send must not go on. */
export async function healMobileNativeChatStaleSend(args: {
  client: RpcClient | null
  enabled: boolean
  connState: ConnectionState
  activeHandleRef: { readonly current: string | null }
  deviceToken: string | null
  deadline: number
}): Promise<string | null> {
  const { client, enabled, connState, activeHandleRef } = args
  const staleTerminal = activeHandleRef.current
  if (!staleTerminal || !isMobileNativeChatInputStale(staleTerminal)) {
    return null
  }
  // Healing writes also need the input lease; retry once ready instead of latching every subsequent send as failed.
  if (!client || !enabled || connState !== 'connected') {
    return 'Message not sent (disconnected)'
  }
  const healed = await healMobileNativeChatStaleInput({
    client,
    terminal: staleTerminal,
    deviceToken: args.deviceToken,
    deadline: args.deadline
  })
  // Abort after a tab switch during clear rather than sending text to a different terminal.
  return healed && activeHandleRef.current === staleTerminal ? null : 'Message not sent'
}
