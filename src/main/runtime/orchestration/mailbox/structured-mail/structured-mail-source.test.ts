import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { expect, it } from 'vitest'
import { readAgentMessageSource } from '../../../../../shared/agent-session/journal/agent-session-message-source'
import { structuredMailMessage, structuredMailSource } from './structured-mail-source'
import { settleStructuredMailAttempt } from './structured-mail-custody'
import { AgentSessionAttachmentStore } from '../../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import { setAgentSessionAttachmentStore } from '../../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { isConversationReport } from '../../../../external-conversations/external-conversation-turn-opener'

it("calls a federated worker of the Run its worker, and an unrelated chat's Run mail unknown", () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const run = db.createRun({
      objective: 'thread',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const remote = db.createDispatchContext({
      taskId: db.createTask({ runId: run.id, spec: 'remote' }).id,
      assigneeHandle: 'term_remote',
      creator: { kind: 'terminal', handle: 'term_coord' },
      maxDepth: 8
    })
    db.db
      .prepare(
        `INSERT INTO federated_dispatches (dispatch_id, environment_id, environment_name, peer_fingerprint)
         VALUES (?, 'env-1', 'Server', 'fp')`
      )
      .run(remote.id)
    const toRun = (from: string) =>
      structuredMailSource({
        db,
        mailboxHandle: `run:${run.id}`,
        dispatchId: null,
        senderSnapshot: () => ({ name: 'Sender', agent: null }),
        batch: [
          {
            id: 'm',
            from_handle: from,
            run_id: run.id,
            type: 'handoff',
            payload: null,
            created_at: '2026-01-01T00:00:00.000Z'
          }
        ]
      }).senders[0]!.relation
    expect(toRun(`dispatch:${remote.id}`)).toBe('worker')
    expect(toRun('orca_session_id:22222222-2222-4222-8222-222222222222')).toBeUndefined()
  } finally {
    db.close()
  }
})

it("marks a worker's mail for the conversation only when a connector-woken turn started it", () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const run = db.createRun({
      objective: 'threads',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const assign = (handle: string, turnSource?: 'connector') =>
      db.createDispatchContext({
        taskId: db.createTask({ runId: run.id, spec: handle }).id,
        assigneeHandle: handle,
        creator: { kind: 'terminal', handle: 'term_coord', ...(turnSource ? { turnSource } : {}) },
        maxDepth: 8
      })
    assign('term_asked', 'connector')
    assign('term_typed')
    const mail = (address: string) =>
      structuredMailSource({
        db,
        mailboxHandle: 'term_coord',
        dispatchId: null,
        senderSnapshot: () => ({ name: 'Sender', agent: null }),
        batch: [
          {
            id: 'm1',
            from_handle: address,
            run_id: run.id,
            type: 'status',
            payload: null,
            created_at: '2026-01-01T00:00:00.000Z'
          }
        ]
      })
    const reloaded = (address: string) =>
      readAgentMessageSource(JSON.parse(JSON.stringify(mail(address))))!.senders[0]

    expect(reloaded('term_asked')).toMatchObject({ relation: 'worker', toConversation: true })
    expect(reloaded('term_typed')).toMatchObject({ relation: 'worker' })
    expect(reloaded('term_typed')).not.toHaveProperty('toConversation')
  } finally {
    db.close()
  }
})

it("tells a thread chat its answer lands there only on its thread's workers' reports", () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const run = db.createRun({
      objective: 'threads',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const assign = (handle: string, turnSource?: 'connector') =>
      db.createDispatchContext({
        taskId: db.createTask({ runId: run.id, spec: handle }).id,
        assigneeHandle: handle,
        creator: { kind: 'terminal', handle: 'term_coord', ...(turnSource ? { turnSource } : {}) },
        maxDepth: 8
      })
    assign('term_asked', 'connector')
    assign('term_typed')
    const text = (from: string) => {
      const { body } = structuredMailMessage({
        db,
        mailboxHandle: `run:${run.id}`,
        dispatchId: null,
        message: db.insertMessage({
          runId: run.id,
          from,
          to: `run:${run.id}`,
          subject: 'Done',
          type: 'status'
        }),
        cliCommand: 'orca',
        senderSnapshot: () => ({ name: 'Sender', agent: null }),
        followUp: undefined,
        // As the runtime decides it (chatMailPlace).
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

    expect(text('term_asked')).toContain(
      '[Orca: your final message and `orca bot reply` (with any files) go to the Slack thread in #eng.]'
    )
    // A worker an Orca-raised turn started, or another bot, has no thread origin: it stays in Orca.
    const stays =
      '[Orca: this mail did not come from the Slack thread in #eng, so your final message stays in Orca.]'
    expect(text('term_typed')).toContain(stays)
    expect(text('term_peer')).toContain(stays)
  } finally {
    db.close()
  }
})

it("sends another bot's answer to a thread ask back to that thread, and only to the chat that asked", () => {
  const db = new OrchestrationDb(':memory:')
  const asker = 'orca_session_id:11111111-1111-4111-8111-111111111111'
  const reviewer = 'orca_session_id:22222222-2222-4222-8222-222222222222'
  try {
    const run = db.createRun({
      objective: 'ask',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const ask = (askedInConversation?: string) => {
      const admitted = db.admitBotRequest({
        rootKey: `root-${askedInConversation ?? 'orca'}`,
        fromBotId: 'ranger',
        toBotId: 'reviewer',
        purpose: 'question',
        depth: 1,
        record: JSON.stringify({
          purpose: 'question',
          ...(askedInConversation ? { askedInConversation } : {})
        }),
        message: {
          runId: run.id,
          from: asker,
          to: reviewer,
          subject: 'review this?',
          type: 'question'
        }
      })
      return admitted.kind === 'sent' ? admitted.message.id : ''
    }
    const note = (mail: { threadId?: string; payload?: string }, sessionId = asker): string => {
      const { body } = structuredMailMessage({
        db,
        mailboxHandle: asker,
        dispatchId: null,
        message: db.insertMessage({
          runId: run.id,
          from: reviewer,
          to: asker,
          subject: 'Re: review this?',
          ...mail
        }),
        cliCommand: 'orca',
        senderSnapshot: () => ({ name: 'Reviewer', agent: null }),
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

    const inThread = ask(asker)
    const answer = {
      threadId: inThread,
      payload: JSON.stringify({ requestId: inThread, botAnswer: {} })
    }
    expect(note(answer)).toContain(there)
    // The notice that no answer came finishes the ask too.
    expect(note({ threadId: inThread })).toContain(there)
    // Only the chat that asked: the same thread read by another chat is not its ask.
    expect(note(answer, reviewer)).toContain(stays)
    // An ask sent from a turn Orca raised, and mail no ask began, stay in Orca.
    expect(note({ threadId: ask() })).toContain(stays)
    expect(note({})).toContain(stays)
  } finally {
    db.close()
  }
})

it("gives a chat the images of item mail and of a bot request about an item as image blocks, and only Orca's payloads", () => {
  const root = '/srv/orca/agent-session-attachments'
  const shot = `${root}/0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01/shot.png`
  setAgentSessionAttachmentStore(new AgentSessionAttachmentStore(root, { hasSession: () => true }))
  const db = new OrchestrationDb(':memory:')
  try {
    const run = db.createRun({
      objective: 'items',
      coordinatorHandle: 'term_bot',
      coordinatorPaneKey: null
    })
    const blocks = (from: string, images: string[], kind = 'botItems') =>
      structuredMailMessage({
        db,
        mailboxHandle: 'term_bot',
        dispatchId: null,
        message: db.insertMessage({
          runId: run.id,
          from,
          to: 'term_bot',
          subject: 'Your owner commented',
          type: 'status',
          payload: JSON.stringify({ [kind]: kind === 'botItems' ? [] : {}, images })
        }),
        cliCommand: 'orca',
        senderSnapshot: () => ({ name: 'Sender', agent: null }),
        followUp: undefined
      }).body.blocks.filter((block) => block.type === 'image-ref')

    expect(blocks('orca:items', [shot, '/etc/passwd.png', '/tmp/x.txt'])).toEqual([
      { type: 'image-ref', path: shot }
    ])
    expect(blocks('term_worker', [shot])).toEqual([])
    expect(blocks('term_worker', [shot], 'botRequest')).toEqual([{ type: 'image-ref', path: shot }])
    expect(blocks('term_worker', [shot], 'task')).toEqual([])
  } finally {
    db.close()
    setAgentSessionAttachmentStore(null)
  }
})

it('reads accepted item mail sent whole with its images, and not once an image went missing', () => {
  const root = '/srv/orca/agent-session-attachments'
  const shot = `${root}/0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01/shot.png`
  setAgentSessionAttachmentStore(new AgentSessionAttachmentStore(root, { hasSession: () => true }))
  const db = new OrchestrationDb(':memory:')
  try {
    const settle = (id: string, sentBlocks: number) => {
      const message = db.insertMessage({
        id,
        from: 'orca:items',
        to: 'term_bot',
        subject: 'Your owner commented',
        body: 'see the screenshot',
        type: 'status',
        payload: JSON.stringify({ botItems: [], images: [shot] })
      })
      const attempt = {
        mailbox_handle: 'term_bot',
        message_id: message.id,
        session_id: 'session-1',
        operation_id: `op-${id}`,
        minted_at_ms: 100
      }
      expect(db.reserveStructuredMailSend(attempt)).toBe(true)
      const { body } = structuredMailMessage({
        db,
        mailboxHandle: 'term_bot',
        dispatchId: null,
        message,
        cliCommand: 'orca',
        senderSnapshot: () => ({ name: null, agent: null }),
        followUp: undefined
      })
      expect(body.blocks.map((block) => block.type)).toEqual(['text', 'image-ref'])
      const sent = { ...body, blocks: body.blocks.slice(0, sentBlocks) }
      const observation = { epoch: 'e', state: { kind: 'accepted' as const }, body: sent }
      settleStructuredMailAttempt(
        db,
        attempt,
        { ...observation, withdrawal: 'unknown' },
        () => 'owed'
      )
      return db.getMessageById(message.id)?.read
    }

    expect(settle('msg_item_whole', 2)).toBe(1)
    expect(settle('msg_item_cut', 1)).toBe(0)
  } finally {
    db.close()
    setAgentSessionAttachmentStore(null)
  }
})
