import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationDb } from '../../db/orchestration-db'
import { queuePeerMailReply } from '../peer-mail/peer-mail-delivery'
import type { PairedServerAsks } from './paired-server-asks-pull'
import { flushPairedServerReturns } from './paired-server-ask-returns'

const REPLY_PAYLOAD = {
  senderLabel: 'Docs',
  fromAddress: 'bot:docs',
  subject: 'Re: Hi',
  body: 'Answer',
  threadId: 'msg_ask',
  replyTo: 'msg_ask'
}

describe('flushPairedServerReturns', () => {
  let dir: string
  let db: OrchestrationDb

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-paired-server-ask-returns-'))
    db = new OrchestrationDb(join(dir, 'orchestration.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function seedConversation(
    conversationId: string,
    environmentId: string,
    peerFingerprint: string,
    messageId: string
  ): void {
    db.linkPeerMailMessage({
      conversationId,
      peerFingerprint,
      environmentId,
      messageId,
      senderLabel: 'Ranger'
    })
  }

  it('clamps return acknowledgments and gone entries to the conversations and sequences sent in the page', async () => {
    seedConversation('conv_sent', 'env_a', 'fp_a', 'msg_ask_sent')
    seedConversation('conv_gone', 'env_a', 'fp_a', 'msg_ask_gone')
    seedConversation('conv_other_peer', 'env_b', 'fp_b', 'msg_ask_other')

    queuePeerMailReply(db, 'conv_sent', 'msg_reply_sent_1', REPLY_PAYLOAD)
    queuePeerMailReply(db, 'conv_gone', 'msg_reply_gone_1', REPLY_PAYLOAD)
    queuePeerMailReply(db, 'conv_other_peer', 'msg_reply_other_1', REPLY_PAYLOAD)

    const callOrchestrationWorkerServer = vi.fn().mockImplementation(async () => {
      // Queued while the RPC is in flight: none of these were in the transmitted page.
      queuePeerMailReply(db, 'conv_sent', 'msg_reply_sent_2', REPLY_PAYLOAD)
      queuePeerMailReply(db, 'conv_gone', 'msg_reply_gone_2', REPLY_PAYLOAD)
      seedConversation('conv_unsent_same_peer', 'env_a', 'fp_a', 'msg_ask_unsent')
      queuePeerMailReply(db, 'conv_unsent_same_peer', 'msg_reply_unsent_1', REPLY_PAYLOAD)
      return {
        acknowledgments: [
          { conversationId: 'conv_sent', throughSequence: 999 },
          { conversationId: 'conv_other_peer', throughSequence: 999 },
          { conversationId: 'conv_unsent_same_peer', throughSequence: 999 }
        ],
        gone: ['conv_gone', 'conv_other_peer']
      }
    })

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double carrying only the runtime methods flushPairedServerReturns calls.
    const runtime = {
      getOrchestrationDb: () => db,
      callOrchestrationWorkerServer
    } as unknown as OrcaRuntimeService

    const asks: PairedServerAsks = {
      environmentId: 'env_a',
      serverName: 'Build Box',
      serverKey: 'fp_a',
      pairing: 'pairing_a',
      wire: { session: 's1', installationId: 'install_a', name: "Alice's Mac" }
    }

    await flushPairedServerReturns(runtime, asks)

    expect(callOrchestrationWorkerServer).toHaveBeenCalledTimes(1)
    expect(db.listPendingFederationRelay('conv_sent', 'to_home').map((r) => r.message_id)).toEqual([
      'msg_reply_sent_2'
    ])
    expect(db.listPendingFederationRelay('conv_gone', 'to_home').map((r) => r.message_id)).toEqual([
      'msg_reply_gone_2'
    ])
    expect(
      db.listPendingFederationRelay('conv_unsent_same_peer', 'to_home').map((r) => r.message_id)
    ).toEqual(['msg_reply_unsent_1'])
    expect(
      db.listPendingFederationRelay('conv_other_peer', 'to_home').map((r) => r.message_id)
    ).toEqual(['msg_reply_other_1'])
  })
})
