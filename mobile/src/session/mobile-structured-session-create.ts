export type MobileStructuredAgent = 'claude' | 'codex'

export function isMobileStructuredAgent(agent: string): agent is MobileStructuredAgent {
  return agent === 'claude' || agent === 'codex'
}

export {
  showStructuredAgentSessionChoice as showMobileStructuredChatChoice,
  structuredAgentSessionCreateFingerprint as mobileStructuredCreateFingerprint
} from '../../../src/shared/structured-agent-session-mutation'
