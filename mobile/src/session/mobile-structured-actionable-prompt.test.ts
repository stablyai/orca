// The phone answers only the prompts the host says still wait on the person: one an agent that
// has ended raised gets no card, and an older host, which names none, keeps today's rule.

import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import {
  actionableStructuredApproval,
  actionableStructuredQuestion
} from './mobile-structured-actionable-prompt'

const PENDING = {
  state: 'pending' as const,
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
}

function approval(itemId: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'approval',
      title: 'Run command?',
      detail: null,
      options: [{ id: 'yes', label: 'Allow' }],
      resolution: PENDING
    }
  }
}

function question(itemId: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'question',
      question: 'Which one?',
      options: [{ id: 'a', label: 'A' }],
      resolution: PENDING
    }
  }
}

const ITEMS = [approval('dead-approval', 1), question('dead-question', 2)]

describe('the prompt a phone answers', () => {
  it('skips one the host does not name, and answers one it does', () => {
    const items = [...ITEMS, approval('live-approval', 3)]
    expect(
      actionableStructuredApproval({ items, actionablePromptIds: ['live-approval'] })?.itemId
    ).toBe('live-approval')
    expect(
      actionableStructuredQuestion({ items, actionablePromptIds: ['live-approval'] })
    ).toBeNull()
  })

  it('is the first pending one when an older host names none', () => {
    expect(actionableStructuredApproval({ items: ITEMS })?.itemId).toBe('dead-approval')
    expect(actionableStructuredQuestion({ items: ITEMS })?.itemId).toBe('dead-question')
  })
})
