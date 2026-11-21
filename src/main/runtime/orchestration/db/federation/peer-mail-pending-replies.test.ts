import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

describe('a paired Orca pulling its replies', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    const conversation = db.db.prepare(
      `INSERT INTO peer_mail_conversations (conversation_id, role, peer_fingerprint) VALUES (?, 'peer', ?)`
    )
    const item = db.db.prepare(
      `INSERT INTO federation_relay_items
         (dispatch_id, direction, sequence, message_id, kind, payload, byte_count, acked_at)
       VALUES (?, ?, ?, ?, 'message', '{}', 2, ?)`
    )
    conversation.run('peerconv_done', 'cred_a')
    item.run('peerconv_done', 'to_home', 1, 'msg_done', '2026-11-01 00:00:00')
    conversation.run('peerconv_waiting', 'cred_a')
    item.run('peerconv_waiting', 'to_home', 1, 'msg_answered', '2026-11-01 00:00:00')
    item.run('peerconv_waiting', 'to_home', 2, 'msg_waiting', null)
    conversation.run('peerconv_inbound', 'cred_a')
    item.run('peerconv_inbound', 'to_worker', 1, 'msg_inbound', null)
    conversation.run('peerconv_other', 'cred_b')
    item.run('peerconv_other', 'to_home', 1, 'msg_other', null)
  })

  afterEach(() => {
    db.close()
  })

  it('finds only its own unacknowledged replies', () => {
    expect(db.listPeerConversationIdsWithPendingReplies('cred_a')).toEqual(['peerconv_waiting'])
  })
})
