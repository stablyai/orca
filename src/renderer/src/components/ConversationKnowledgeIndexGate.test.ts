import { describe, expect, it } from 'vitest'
import { CONVERSATION_KNOWLEDGE_FORMAT_VERSION } from '../../../shared/conversation-knowledge-items'
import { shouldRunConversationKnowledgeAutoIndex } from './ConversationKnowledgeIndexGate'

describe('shouldRunConversationKnowledgeAutoIndex', () => {
  it('runs initially and no more than once per day', () => {
    const now = Date.UTC(2026, 8, 8, 12)
    expect(shouldRunConversationKnowledgeAutoIndex(null, now)).toBe(true)
    expect(shouldRunConversationKnowledgeAutoIndex(now - 23 * 60 * 60 * 1_000, now)).toBe(false)
    expect(shouldRunConversationKnowledgeAutoIndex(now - 24 * 60 * 60 * 1_000, now)).toBe(true)
  })

  it('runs immediately when the stored enrichment format is stale', () => {
    const now = Date.now()
    expect(
      shouldRunConversationKnowledgeAutoIndex(now, now, CONVERSATION_KNOWLEDGE_FORMAT_VERSION - 1)
    ).toBe(true)
  })
})
