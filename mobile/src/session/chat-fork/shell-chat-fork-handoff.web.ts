import type { BridgeChatForkCall } from '../../mobile-web-shell/bridge/native-capabilities/bridge-chat-fork-verb'
import { useNativeVerbs } from '../../mobile-web-shell/bridge/native-capabilities/use-native-verbs'

// The page reaches only its own desktop; a shell that serves the verb shows a sheet with every paired host.
export function useShellChatForkHandoff(): BridgeChatForkCall | null {
  const verbs = useNativeVerbs()
  return verbs.canForkChat ? verbs.forkChat : null
}
