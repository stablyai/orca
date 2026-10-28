import { resolveMobileTerminalTabOwnedAgentId } from './mobile-terminal-tab-agent'
import type { MobileSessionTab } from './mobile-session-route-types'

export function resolveMobileImageAttachmentAgent(
  tab: MobileSessionTab | null | undefined,
  nativeChatAgent: string | null
): string | null {
  if (tab?.type === 'terminal') {
    return resolveMobileTerminalTabOwnedAgentId(tab) ?? nativeChatAgent
  }
  return nativeChatAgent
}
