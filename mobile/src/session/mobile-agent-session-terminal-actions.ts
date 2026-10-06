import { SquareTerminal } from 'lucide-react-native'
import {
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent
} from '../../../src/shared/agent-session-resume'
import type { ActionSheetAction } from '../components/ActionSheetModal'

/** A structured Chat tab whose own conversation a terminal can open. */
export type MobileAgentSessionTerminalOpen = {
  sessionId: string
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
}

/**
 * The Chat tab's long-press menu: the hand-off when it resolves, nothing when it does not.
 *
 * The provider session comes from a history read, so a tab whose transcript was never read — and
 * any tab whose agent has no TUI resume — offers nothing; an older host degrades by never showing
 * the item rather than by a capability this client would have to negotiate.
 */
export function getMobileAgentSessionTerminalActions(args: {
  tab: { sessionId: string; agent: string } | null
  providerSession: AgentProviderSessionMetadata | null
  onOpen: (open: MobileAgentSessionTerminalOpen) => void
}): ActionSheetAction[] {
  const { tab, providerSession } = args
  if (!tab || !providerSession || !isResumableTuiAgent(tab.agent)) {
    return []
  }
  const open: MobileAgentSessionTerminalOpen = {
    sessionId: tab.sessionId,
    agent: tab.agent,
    providerSession
  }
  return [
    {
      label: 'Open in Terminal',
      icon: SquareTerminal,
      onPress: () => args.onOpen(open)
    }
  ]
}
