import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import {
  buildMobileStructuredTimeline,
  activeMobileStructuredTurnId,
  restoreMobileStructuredAttachments
} from './mobile-structured-session-timeline'
import type { MobileStructuredOutboxEntry } from './mobile-structured-outbox-store'

const APPROVAL: AgentJournalRenderItem = {
  itemId: 'orca:approval',
  revision: 4,
  sequence: 2,
  observedAt: 1,
  body: {
    kind: 'approval',
    title: 'Run command?',
    detail: 'pnpm test',
    options: [{ id: 'accept', label: 'Allow' }],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}

const OUTBOX: MobileStructuredOutboxEntry = {
  clientMessageId: 'mobile-send:1:id',
  sessionId: 'mobile_1',
  body: {
    kind: 'message',
    role: 'user',
    blocks: [
      { type: 'text', text: 'look' },
      { type: 'image-ref', path: '/tmp/image.png' }
    ]
  },
  previewUris: ['file:///preview.png'],
  state: 'unconfirmed',
  queuedAt: 3,
  lastAttemptAt: 4,
  retryAfterUnknownSubmittedAt: null
}

describe('mobile structured session timeline', () => {
  it.each([5, 10])('renders %i authoritative mobile sends exactly once', (sendCount) => {
    const items = Array.from(
      { length: sendCount },
      (_, index): AgentJournalRenderItem => ({
        itemId: `orca:client-${index}`,
        revision: 1,
        sequence: index + 1,
        observedAt: index + 1,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: `RAPID_${index + 1}` }]
        }
      })
    )

    const rows = buildMobileStructuredTimeline(items, [])
    expect(
      rows.filter((row) => row.kind === 'message' && row.message.role === 'user')
    ).toHaveLength(sendCount)
  })

  it('keeps pending prompts as cards and unknown sends as their original bubble', () => {
    const rows = buildMobileStructuredTimeline([APPROVAL], [OUTBOX])

    expect(rows[0]).toMatchObject({ kind: 'prompt', key: 'orca:approval' })
    expect(rows[1]).toMatchObject({
      kind: 'message',
      key: agentJournalSubmissionKey(OUTBOX.clientMessageId),
      outbox: { state: 'unconfirmed' },
      message: { blocks: [{ type: 'text', text: 'look' }, { url: 'file:///preview.png' }] }
    })
  })

  it('adopts the WAL row instead of drawing the send twice while it dispatches', () => {
    const wal: AgentJournalRenderItem = {
      itemId: agentJournalSubmissionKey(OUTBOX.clientMessageId),
      revision: 0,
      sequence: 1,
      observedAt: 3,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'look' }] }
    }

    const rows = buildMobileStructuredTimeline([wal], [OUTBOX])
    const optimistic = buildMobileStructuredTimeline([], [OUTBOX])

    expect(rows).toHaveLength(1)
    // The entry rides the canonical row, so Retry / edit-queued stay reachable.
    expect(rows[0]).toMatchObject({ key: wal.itemId, outbox: { state: 'unconfirmed' } })
    expect(optimistic[0]?.key).toBe(rows[0]?.key)
  })

  it('keeps the device-local thumbnail on the adopted row while delivery is unconfirmed', () => {
    const wal: AgentJournalRenderItem = {
      itemId: agentJournalSubmissionKey(OUTBOX.clientMessageId),
      revision: 1,
      sequence: 1,
      observedAt: 3,
      body: OUTBOX.body
    }

    const rows = buildMobileStructuredTimeline([wal], [OUTBOX])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      key: wal.itemId,
      outbox: { state: 'unconfirmed' },
      message: {
        blocks: [
          { type: 'text', text: 'look' },
          { type: 'image-ref', url: 'file:///preview.png' }
        ]
      }
    })
  })

  it('restores host paths and local previews when a queued send is edited', () => {
    expect(restoreMobileStructuredAttachments(OUTBOX)).toEqual([
      {
        id: `restored:${OUTBOX.clientMessageId}:0`,
        path: '/tmp/image.png',
        previewUri: 'file:///preview.png'
      }
    ])
  })

  it('shows cancellation only while the durable root-turn lifecycle is running', () => {
    const lifecycle: AgentJournalRenderItem = {
      itemId: 'legacy:codex:mobile_1:turn-lifecycle%3Aturn-7',
      revision: 1,
      sequence: 5,
      observedAt: 1,
      body: {
        kind: 'status',
        text: '',
        turnLifecycle: { turnId: 'turn-7', state: 'running' }
      }
    }
    expect(activeMobileStructuredTurnId([APPROVAL, lifecycle])).toBe('turn-7')
    expect(
      activeMobileStructuredTurnId([
        APPROVAL,
        {
          ...lifecycle,
          revision: 2,
          body: {
            kind: 'status',
            text: '',
            turnLifecycle: { turnId: 'turn-7', state: 'completed' }
          }
        }
      ])
    ).toBeNull()
    expect(buildMobileStructuredTimeline([lifecycle], [])).toEqual([])
  })
})
