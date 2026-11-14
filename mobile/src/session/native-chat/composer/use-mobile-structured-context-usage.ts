import { useMemo } from 'react'
import type { AgentJournalRenderItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionOptionsResult } from '../../../../../src/shared/agent-session/options/protocol/agent-session-options-result'
import { selectStructuredAgentSessionContextUsage } from '../../../../../src/shared/agent-session/structured-agent-session-context-usage'
import {
  summarizeContextUsage,
  type NativeChatContextUsageSummary
} from '../../../../../src/shared/native-chat/native-chat-context-usage-summary'

/** The composer ring's readout, from desktop's rule; an older host's missing answer leaves the loaded window's facts. */
export function useMobileStructuredContextUsage(
  journalItems: readonly AgentJournalRenderItem[],
  support: AgentSessionOptionsResult['contextUsage'],
  journalEpoch: string | null
): NativeChatContextUsageSummary | null {
  return useMemo(() => {
    const usage = selectStructuredAgentSessionContextUsage(journalItems, support, journalEpoch)
    return usage ? summarizeContextUsage(usage) : null
  }, [journalItems, support, journalEpoch])
}
