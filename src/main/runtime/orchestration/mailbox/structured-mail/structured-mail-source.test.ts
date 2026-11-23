import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import { structuredMailSource } from './structured-mail-source'
import { isConversationReport } from '../../../../external-conversations/external-conversation-turn-opener'
import type { DispatchStatus } from '../../db/orchestration-records'

describe('structured mail conversation routing', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function deliveredAfter(status: DispatchStatus, turnSource?: 'connector') {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'thread work',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: null
    })
    const task = db.createTask({ runId: run.id, spec: 'work' })
    const dispatch = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_worker',
      creator: {
        kind: 'terminal',
        handle: 'term_coordinator',
        ...(turnSource ? { turnSource } : {})
      },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    const message = db.insertMessage({
      runId: run.id,
      from: 'term_worker',
      to: `run:${run.id}`,
      subject: 'Usage limit',
      type: 'escalation',
      senderDispatchId: dispatch.id
    })
    // Delivery can be held past settlement, so the Dispatch's state at delivery is arbitrary.
    db.db.prepare('UPDATE dispatch_contexts SET status = ? WHERE id = ?').run(status, dispatch.id)
    const from = structuredMailSource({
      db,
      mailboxHandle: `run:${run.id}`,
      dispatchId: null,
      batch: [message],
      senderSnapshot: () => ({ name: 'worker', agent: null })
    })
    return isConversationReport({ kind: 'message', role: 'user', blocks: [], from })
  }

  const statuses: DispatchStatus[] = [
    'pending',
    'dispatched',
    'completed',
    'failed',
    'circuit_broken'
  ]

  it.each(statuses)(
    'routes mail from a connector-started Dispatch to its thread when %s',
    (status) => {
      expect(deliveredAfter(status, 'connector')).toBe(true)
    }
  )

  it('keeps mail from an Orca-started Dispatch in Orca', () => {
    expect(deliveredAfter('failed')).toBe(false)
  })
})

it("sends the owner's answer to an item question a thread asked back to that thread, and only Orca's item mail", () => {
  const db = new OrchestrationDb(':memory:')
  const asker = 'orca_session_id:11111111-1111-4111-8111-111111111111'
  const other = 'orca_session_id:22222222-2222-4222-8222-222222222222'
  try {
    const note = (from: string, askedInConversation: string | undefined, sessionId = asker) => {
      const { body } = structuredMailMessage({
        db,
        mailboxHandle: sessionId,
        dispatchId: null,
        message: db.insertMessage({
          from,
          ...(from === 'orca:items' ? { orcaAuthored: 'item-mail' as const } : {}),
          to: sessionId,
          subject: 'Item #4 answered',
          type: 'status',
          payload: JSON.stringify({
            botItems: [],
            ...(askedInConversation ? { askedInConversation } : {})
          })
        }),
        cliCommand: 'orca',
        senderSnapshot: () => ({ name: 'Items', agent: null }),
        followUp: undefined,
        sessionId,
        conversationPlace: (source) => ({
          place: 'the Slack thread in #eng',
          answersThere: isConversationReport({
            kind: 'message',
            role: 'user',
            blocks: [],
            from: source
          })
        })
      })
      return body.blocks.map((block) => ('text' in block ? block.text : '')).join('')
    }
    const there = 'go to the Slack thread in #eng.]'
    const stays = 'so your final message stays in Orca.]'

    expect(note('orca:items', asker)).toContain(there)
    // Another chat reading it, item mail no thread asked, and anyone else's payload stay in Orca.
    expect(note('orca:items', asker, other)).toContain(stays)
    expect(note('orca:items', undefined)).toContain(stays)
    expect(note(other, asker)).toContain(stays)
  } finally {
    db.close()
  }
})
