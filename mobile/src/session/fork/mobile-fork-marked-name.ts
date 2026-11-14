import { translate } from '../../i18n/mobile-i18n'
import type { AgentSessionConversationNames } from '../../../../src/shared/agent-session/agent-session-conversation-names'
import type { AgentSessionConversationName } from '../../../../src/shared/agent-session/agent-session-wire'
import {
  agentSessionForkSourceSavedName,
  agentSessionShownName
} from '../../../../src/shared/agent-session/agent-session-fork-name'
import type { AgentType } from '../../../../src/shared/agent-status/contracts/agent-status-types'
import {
  FORK_MARKED_NAME_SLOTS,
  forkMarkedNameParts,
  type ForkMarkedNamePart
} from '../../../../src/shared/agent-session/agent-session-fork-name-order'

/** A forked chat's title in the locale's order: the "Fork ·" mark and the name as separate parts. */
export function mobileForkMarkedNameParts(): ForkMarkedNamePart[] {
  return forkMarkedNameParts(
    translate('chat.fork.markedName', '{{mark}} {{name}}', {
      ...FORK_MARKED_NAME_SLOTS,
      interpolation: { escapeValue: false }
    })
  )
}

export function mobileForkMark(): string {
  return translate('chat.fork.mark', 'Fork ·')
}

/** What a screen reader hears for a forked chat's title. */
export function mobileForkAccessibleName(name: string): string {
  return translate('chat.fork.accessibleName', 'Fork: {{name}}', {
    name,
    interpolation: { escapeValue: false }
  })
}

/** A chat's shown name from its host's naming map: an older fork's appended " fork" is dropped
 *  while it still matches its source's saved name. A fork shares its source's agent. */
export function mobileChatShownName(
  names: AgentSessionConversationNames,
  note: AgentSessionConversationName,
  agent: AgentType | null | undefined
): string | null {
  const source = note.forkedFrom ? names.get(note.forkedFrom.sessionId) : undefined
  return agentSessionShownName(
    note,
    source ? agentSessionForkSourceSavedName(source, agent) : undefined
  )
}
