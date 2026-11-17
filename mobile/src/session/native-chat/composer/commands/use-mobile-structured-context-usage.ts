import { useMemo } from 'react'
import type { AgentJournalRenderItem } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionOptionsResult } from '../../../../../../src/shared/agent-session/options/protocol/agent-session-options-result'
import { selectStructuredAgentSessionContextUsage } from '../../../../../../src/shared/agent-session/conversation-context/structured-agent-session-context-usage'
import {
  summarizeContextUsage,
  type NativeChatContextUsageSummary
} from '../../../../../../src/shared/native-chat/native-chat-context-usage-summary'
import { rowsBesideStreamedText } from '../../../../../../src/shared/agent-session/view/structured-agent-session-streamed-text-rows'

/** The composer ring's readout, from desktop's rule; an older host's missing answer leaves the loaded window's facts. */
export function useMobileStructuredContextUsage(
  journalItems: readonly AgentJournalRenderItem[],
  support: AgentSessionOptionsResult['contextUsage'],
  journalEpoch: string | null
): NativeChatContextUsageSummary | null {
  // Usage never reads reply text, so a streaming reply keeps the memo.
  const rows = rowsBesideStreamedText(journalItems)
  return useMemo(() => {
    const usage = selectStructuredAgentSessionContextUsage(rows, support, journalEpoch)
    return usage ? summarizeContextUsage(usage) : null
  }, [rows, support, journalEpoch])
}
