import type { AiVaultSession } from '../../shared/ai-vault-types'
import { reconcileConversationKnowledgeConflicts } from '../../shared/conversation-knowledge-conflicts'
import {
  isConversationKnowledgeGenerationTitle,
  type ConversationKnowledgeItem
} from '../../shared/conversation-knowledge-items'
import { hydrateConversationKnowledgeSourceTimes } from './conversation-knowledge-source'

export function visibleConversationKnowledgeItems(args: {
  items: readonly ConversationKnowledgeItem[]
  sourceSessions: readonly AiVaultSession[]
  emptyIds: ReadonlySet<string>
  legacyEmptyIds: ReadonlySet<string>
}): ConversationKnowledgeItem[] {
  return reconcileConversationKnowledgeConflicts(
    hydrateConversationKnowledgeSourceTimes(
      args.items.filter(
        (item) =>
          !args.emptyIds.has(item.id) &&
          !args.legacyEmptyIds.has(item.id) &&
          !isConversationKnowledgeGenerationTitle(item.source.title)
      ),
      args.sourceSessions
    )
  )
}
