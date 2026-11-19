// One subagent's own view, built from the rows the phone already holds for its parent chat.

import type { AgentJournalRenderItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemSubagentId } from '../../../../../src/shared/agent-session/journal/agent-session-journal-producer'
import type { StructuredAgentSubagentRoster } from '../../../../../src/shared/agent-session/view/structured-agent-session-subagent-roster'
import type { AgentType } from '../../../../../src/shared/agent-status/contracts/agent-status-types'
import {
  isSubagentBlock,
  isSubagentGroupBlock,
  type NativeChatMessage,
  type NativeChatSubagentEntry
} from '../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatSubagentRow } from '../../../../../src/shared/native-chat/transcript/native-chat-transcript-projection'
import { nativeChatSubagentHandoff } from '../../../../../src/shared/native-chat/transcript/subagents/native-chat-subagent-handoff'
import {
  nativeChatSubagentEnding,
  nativeChatSubagentEndingMessage,
  type NativeChatSubagentAside
} from '../../../../../src/shared/native-chat/transcript/subagents/native-chat-subagent-ending'
import { subagentEntryOf } from '../../../../../src/shared/native-chat/transcript/subagents/native-chat-subagent-items'
import { foldMobileNativeChatMessages } from '../transcript/projection/mobile-native-chat-render-data'
import { translate } from '../../../i18n/mobile-i18n'

/** A structured chat's journal and named subagents; a terminal chat has neither. */
export type MobileNativeChatSubagentSource = {
  journalItems: readonly AgentJournalRenderItem[]
  roster: StructuredAgentSubagentRoster | undefined
}

export type MobileNativeChatSubagentView = {
  entry: NativeChatSubagentEntry | undefined
  /** What the main agent asked of it, when its spawn call is loaded. */
  prompt: string | null
  /** Its own rows, folded as the conversation's are, then how it ended. */
  rows: readonly NativeChatMessage[]
}

function asideText(aside: NativeChatSubagentAside): string {
  switch (aside) {
    case 'no-steps':
      return translate('chat.subagentView.noSteps', 'No steps yet')
    case 'cleared':
      return translate(
        'chat.subagentView.beforeClear',
        'This subagent ran before the chat was cleared'
      )
    case 'stopped':
      return translate('chat.subagentView.stoppedBeforeReply', 'Stopped before replying')
    case 'no-reply':
      return translate('chat.subagentView.noReply', 'Ended without a reply')
  }
}

/** The roster entry the reader tapped (its label disambiguated), else its own row, else the session roster. */
export function mobileNativeChatSubagentEntry(
  agentId: string,
  folded: readonly NativeChatMessage[],
  messages: readonly NativeChatMessage[],
  roster: StructuredAgentSubagentRoster | undefined
): NativeChatSubagentEntry | undefined {
  const tapped = folded
    .flatMap(({ blocks }) => blocks.flatMap((one) => (isSubagentGroupBlock(one) ? one.agents : [])))
    .find((one) => one.id === agentId)
  const own = messages
    .flatMap(({ blocks }) => blocks)
    .find((one) => isSubagentBlock(one) && one.id === agentId)
  return (
    tapped ?? (own && isSubagentBlock(own) ? subagentEntryOf(own) : roster?.get(agentId)?.entry)
  )
}

export function mobileNativeChatSubagentView({
  agentId,
  messages,
  folded,
  agent,
  source
}: {
  agentId: string
  /** The chat's rows before projection, every producer's. */
  messages: readonly NativeChatMessage[]
  /** The conversation as the chat draws it, which holds the spawn calls. */
  folded: readonly NativeChatMessage[]
  agent: AgentType
  source: MobileNativeChatSubagentSource | undefined
}): MobileNativeChatSubagentView {
  // A nested subagent's spawn call sits in its parent's own rows.
  const subagentRows = new Map<string, NativeChatSubagentRow[]>()
  for (const message of messages) {
    const id = agentJournalItemSubagentId(message)
    if (id !== null) {
      const rows = subagentRows.get(id) ?? []
      rows.push({ message, turnKey: undefined })
      subagentRows.set(id, rows)
    }
  }
  const own = foldMobileNativeChatMessages(messages, agent, agentId)
  const entry = mobileNativeChatSubagentEntry(agentId, folded, messages, source?.roster)
  const handoff = nativeChatSubagentHandoff({
    agentId,
    journalItems: source?.journalItems,
    conversation: folded,
    subagentRows
  })
  const ending = nativeChatSubagentEnding({ entry, handoff, rows: own, history: 'landed' })
  return {
    entry,
    prompt: handoff.prompt,
    rows:
      ending === null
        ? own
        : [
            ...own,
            nativeChatSubagentEndingMessage(
              agentId,
              ending,
              ending.kind === 'aside' ? asideText(ending.aside) : '',
              entry?.settledAt
            )
          ]
  }
}
