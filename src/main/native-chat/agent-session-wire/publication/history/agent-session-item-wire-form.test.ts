import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { shortenedAgentJournalItem } from './agent-session-item-wire-form'

it('drops only optional receipt facts before shortening a previously fitting saved item', () => {
  const item: AgentJournalRenderItem = {
    itemId: 'orca:a',
    revision: 1,
    sequence: 2,
    observedAt: 3,
    body: {
      kind: 'automation-saved',
      change: 'created',
      automation: {
        id: 'a',
        name: 'Keep the whole name',
        enabled: true,
        nextRunAt: 0,
        updatedAt: 3,
        dtstart: 0,
        rrule: '0 * * * *',
        workspaceId: null
      },
      receiptFacts: {
        version: 1,
        automationCreatedAt: 1,
        zone: { kind: 'not-recorded' },
        triggerExtras: {
          coverage: 'complete',
          items: [
            {
              triggerId: 'g',
              additionalConditions: 'none',
              google: { kind: 'gmail', account: { kind: 'named', value: '界'.repeat(200) } }
            }
          ]
        }
      }
    }
  }
  const result = shortenedAgentJournalItem(item, 500)
  expect(result).toEqual({
    itemId: 'orca:a',
    revision: 1,
    sequence: 2,
    observedAt: 3,
    body: {
      kind: 'automation-saved',
      change: 'created',
      automation: {
        id: 'a',
        name: 'Keep the whole name',
        enabled: true,
        nextRunAt: 0,
        updatedAt: 3,
        dtstart: 0,
        rrule: '0 * * * *',
        workspaceId: null
      },
      receiptFacts: { version: 1, unavailable: 'item-budget' }
    }
  })
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(500)
})
