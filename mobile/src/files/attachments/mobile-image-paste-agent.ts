import { resolveMobileTerminalTabOwnedAgentId } from '../../session/tabs/mobile-terminal-tab-agent'
import type { MobileSessionTab } from '../../session/tabs/mobile-session-tabs'

export function resolveMobileImageAttachmentAgent(
  tab: MobileSessionTab | null | undefined,
  nativeChatAgent: string | null
): string | null {
  if (tab?.type === 'terminal') {
    return resolveMobileTerminalTabOwnedAgentId(tab) ?? nativeChatAgent
  }
  return nativeChatAgent
}
