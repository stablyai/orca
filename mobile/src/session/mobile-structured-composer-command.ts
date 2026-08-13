import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionComposerCommand,
  structuredAgentSessionSlashCommands,
  STRUCTURED_AGENT_SESSION_SLASH_COMMANDS,
  type StructuredAgentSessionCommandOutcome
} from '../../../src/shared/structured-agent-session-composer'
import type { MobileStructuredAgent } from './mobile-structured-session-create'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'

export const MOBILE_STRUCTURED_SLASH_COMMANDS = STRUCTURED_AGENT_SESSION_SLASH_COMMANDS
export type MobileStructuredCommandOutcome = StructuredAgentSessionCommandOutcome

export function mobileStructuredSlashCommands(agent: MobileStructuredAgent) {
  return structuredAgentSessionSlashCommands(agent)
}

export function isMobileStructuredComposerCommand(
  text: string,
  agent: MobileStructuredAgent
): boolean {
  return isStructuredAgentSessionComposerCommand(text, agent)
}

export function dispatchMobileStructuredComposerCommand(
  text: string,
  controller: MobileNativeChatSessionOptionsController,
  agent: MobileStructuredAgent
): Promise<MobileStructuredCommandOutcome> {
  return dispatchStructuredAgentSessionComposerCommand(text, { ...controller, agent })
}
