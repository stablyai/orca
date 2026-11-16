import type { BridgeChatForkCall } from '../../mobile-web-shell/bridge/native-capabilities/bridge-chat-fork-verb'

// The app already holds every paired host, so its own sheet runs here; only the served page hands off.
export function useShellChatForkHandoff(): BridgeChatForkCall | null {
  return null
}
