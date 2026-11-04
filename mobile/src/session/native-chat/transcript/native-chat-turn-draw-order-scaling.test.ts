import { expect, it } from 'vitest'
import { nativeChatTurnDrawOrder } from '../../../../../src/shared/native-chat/transcript/native-chat-turn-grouping'
import { nativeChatTurnMembership } from '../../../../../src/shared/native-chat-turn-membership'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../../src/shared/agent-session-journal-types'

it.each([10, 100])(
  'reads turn ownership linearly for %i queued openers and earlier-turn rows',
  (count) => {
    const messages = [
      { id: 'first', role: 'user' as const },
      ...Array.from({ length: count }, (_, index) => ({
        id: `queued-${index}`,
        role: 'user' as const
      })),
      ...Array.from({ length: count }, (_, index) => ({
        id: `tail-${index}`,
        role: 'assistant' as const
      })),
      ...Array.from({ length: count }, (_, index) => ({
        id: `answer-${index}`,
        role: 'assistant' as const
      }))
    ]
    const keys = [
      'first',
      ...Array.from({ length: count }, (_, index) => `queued-${index}`),
      ...Array.from({ length: count }, () => 'first'),
      ...Array.from({ length: count }, (_, index) => `queued-${index}`)
    ]
    const openers = new Set(keys.slice(0, count + 1))
    let reads = 0
    keys.forEach((key, index) => {
      Object.defineProperty(keys, index, {
        get: () => {
          reads += 1
          return key
        }
      })
    })
    const order = nativeChatTurnDrawOrder(messages, keys, openers)
    const visits = reads
    expect(order?.map((index) => messages[index]?.id)).toEqual([
      'first',
      ...Array.from({ length: count }, (_, index) => `tail-${index}`),
      ...Array.from({ length: count }, (_, index) => [`queued-${index}`, `answer-${index}`]).flat()
    ])
    const journalItems: AgentJournalRenderItem[] = []
    const append = (itemId: string, body: AgentJournalItemBody, turnItemId: string) => {
      const sequence = journalItems.length + 1
      journalItems.push({
        itemId,
        body,
        revision: 0,
        sequence,
        observedAt: sequence,
        turnScope: { kind: 'turn', turnItemId }
      })
    }
    append('first', { kind: 'message', role: 'user', blocks: [] }, 'turn-first')
    append(
      'turn-first',
      { kind: 'turn', turnId: 'first', state: 'completed', userItemId: 'first' },
      'turn-first'
    )
    for (let index = 0; index < count; index += 1) {
      append(`queued-${index}`, { kind: 'message', role: 'user', blocks: [] }, `turn-${index}`)
    }
    for (let index = 0; index < count; index += 1) {
      append(`tail-${index}`, { kind: 'message', role: 'assistant', blocks: [] }, 'turn-first')
    }
    for (let index = 0; index < count; index += 1) {
      append(
        `turn-${index}`,
        { kind: 'turn', turnId: `t${index}`, state: 'completed', userItemId: `queued-${index}` },
        `turn-${index}`
      )
      append(`answer-${index}`, { kind: 'message', role: 'assistant', blocks: [] }, `turn-${index}`)
    }
    const membership = nativeChatTurnMembership(messages, { items: journalItems, submissions: [] })
    expect(membership.turnKeys).toEqual(keys)
    expect(membership.drawOrder).toEqual(order)
    expect(visits).toBeLessThanOrEqual(messages.length * 4)
  }
)
