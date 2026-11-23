import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationDb } from '../../db/orchestration-db'
import { importPairedServerItem } from './paired-server-ask-import'
import { flushPairedServerReturns } from './paired-server-ask-returns'
import { retirePairedServerRoute } from './paired-server-ask-removal'
import { admitPairedServerAsks } from './paired-server-ask-admission'
import { queuePeerMailReply } from '../peer-mail/peer-mail-delivery'
import { ORCHESTRATION_PEER_MAIL_METHODS } from '../../../rpc/methods/orchestration/federation/peer-mail-methods'
import { replyOverPeerMail } from '../../../rpc/methods/orchestration/messaging/peer-mail-reply'
import type { RpcContext } from '../../../rpc/core'
import {
  getPairedServerAsk,
  holdPairedServerAsk
} from '../../db/federation/paired-server-asks-store'
import { noteAnnounced, owesAnnouncement, type PairedServerAsks } from './paired-server-asks-pull'

const SERVER: PairedServerAsks = {
  environmentId: 'env_s',
  serverName: 'Build Box',
  serverKey: 'fingerprint_s',
  pairing: 'fingerprint_a',
  wire: { session: 'session_1', installationId: 'install_a', name: "Alice's Mac" }
}

const Returned = z.object({ items: z.array(z.object({ messageId: z.string() })) })

describe('what this computer hands back to a paired server', () => {
  let dir: string
  let db: OrchestrationDb
  let pages: string[][]
  let answer: (page: number) => unknown
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-paired-server-returns-'))
    db = new OrchestrationDb(join(dir, 'computer.db'))
    pages = []
    answer = () => ({ acknowledgments: [], gone: [] })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the members the returns and import code read.
    runtime = {
      getOrchestrationDb: () => db,
      readMachineName: () => "Alice's Mac",
      bots: { list: () => [] },
      orchestrationSenderNames: {
        sender: () => ({ name: 'Docs', party: { orcaSessionId: null } })
      },
      notifyBotsChanged: () => {},
      callOrchestrationWorkerServer: vi.fn(
        async (_environment: string, _method: string, params: unknown) => {
          pages.push(Returned.parse(params).items.map((item) => item.messageId))
          return answer(pages.length)
        }
      )
    } as unknown as OrcaRuntimeService
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const open = (conversationId: string, environmentId: string) =>
    db.db
      .prepare(
        `INSERT INTO peer_mail_conversations (conversation_id, role, peer_fingerprint, environment_id)
         VALUES (?, 'peer', ?, ?)`
      )
      .run(conversationId, SERVER.pairing, environmentId)

  const queue = (conversationId: string, messageId: string) =>
    db.enqueueFederationRelay({
      dispatchId: conversationId,
      direction: 'to_home',
      kind: 'peer_mail',
      messageId,
      payload: '{}'
    })

  it("opens no conversation for an ask naming a dispatch, so that dispatch's reports never go back", async () => {
    const dispatchId = 'ctx_0000000000d1'
    queue(dispatchId, 'msg_worker_report')

    await importPairedServerItem(runtime, db, SERVER, {
      conversationId: dispatchId,
      messageId: 'm_dispatch',
      kind: 'client_ask',
      payload: JSON.stringify({
        to: 'bot:docs',
        senderLabel: 'Ranger',
        subject: 'Hi',
        type: 'status',
        rootSession: 'orca_session_id:asker'
      })
    })
    await flushPairedServerReturns(runtime, SERVER)

    expect(db.getPeerMailConversation(dispatchId)).toBeFalsy()
    expect(pages).toEqual([])
    expect(db.listPendingFederationRelay(dispatchId, 'to_home')).toHaveLength(1)
  })

  it('takes acknowledgments only for what it handed back: never past the page, never another conversation', async () => {
    const sentHere = 'peerconv_0000000000b1'
    const otherServer = 'peerconv_0000000000b2'
    open(sentHere, SERVER.environmentId)
    open(otherServer, 'env_other')
    // One more than a page, so the last waits for the next one.
    for (let index = 0; index < 51; index += 1) {
      queue(sentHere, `msg_return_${index}`)
    }
    queue(otherServer, 'msg_other_server')
    // The first answer claims far more than it was sent, and another server's conversation.
    answer = (page) =>
      page === 1
        ? {
            acknowledgments: [
              { conversationId: sentHere, throughSequence: 1_000_000 },
              { conversationId: otherServer, throughSequence: 1_000_000 }
            ],
            gone: [otherServer]
          }
        : { acknowledgments: [], gone: [] }

    await flushPairedServerReturns(runtime, SERVER)

    expect(pages.map((page) => page.length)).toEqual([50, 1])
    expect(pages[1]).toEqual(['msg_return_50'])
    expect(db.listPendingFederationRelay(sentHere, 'to_home')).toHaveLength(1)
    expect(db.listPendingFederationRelay(otherServer, 'to_home')).toHaveLength(1)
  })

  it('sends a full page the server took none of once per wake, never again at once', async () => {
    const conversation = 'peerconv_0000000000c1'
    open(conversation, SERVER.environmentId)
    for (let index = 0; index < 50; index += 1) {
      queue(conversation, `msg_full_${index}`)
    }

    await flushPairedServerReturns(runtime, SERVER)
    expect(pages).toHaveLength(1)
    await flushPairedServerReturns(runtime, SERVER)
    expect(pages).toHaveLength(2)
    expect(db.listPendingFederationRelay(conversation, 'to_home')).toHaveLength(50)
  })

  it('moves past a conversation the server never takes, so the next one still goes back', async () => {
    const stuck = 'peerconv_0000000000c9'
    const next = 'peerconv_0000000000ca'
    open(stuck, SERVER.environmentId)
    open(next, SERVER.environmentId)
    for (let index = 0; index < 50; index += 1) {
      queue(stuck, `msg_stuck_${index}`)
    }
    queue(next, 'msg_next')
    // The server takes only the second conversation's mail, whenever it is sent.
    answer = () => ({
      acknowledgments: [{ conversationId: next, throughSequence: 1 }],
      gone: []
    })

    await flushPairedServerReturns(runtime, SERVER)
    await flushPairedServerReturns(runtime, SERVER)

    expect(pages[0]).not.toContain('msg_next')
    expect(pages[1]![0]).toBe('msg_next')
    expect(db.listPendingFederationRelay(next, 'to_home')).toEqual([])
    expect(db.listPendingFederationRelay(stuck, 'to_home')).toHaveLength(50)
  })

  it('settles a conversation the server has gone only through what this page sent it', async () => {
    const gone = 'peerconv_0000000000c2'
    const later = 'peerconv_0000000000c3'
    open(gone, SERVER.environmentId)
    open(later, SERVER.environmentId)
    for (let index = 0; index < 51; index += 1) {
      queue(gone, `msg_gone_${index}`)
    }
    queue(later, 'msg_later')
    // Both are named gone, though the page held only the first's oldest 50.
    answer = (page) =>
      page === 1 ? { acknowledgments: [], gone: [gone, later] } : { acknowledgments: [], gone: [] }

    await flushPairedServerReturns(runtime, SERVER)

    expect(pages[0]).toHaveLength(50)
    expect(db.listPendingFederationRelay(gone, 'to_home').map((item) => item.message_id)).toEqual([
      'msg_gone_50'
    ])
    expect(db.listPendingFederationRelay(later, 'to_home')).toHaveLength(1)
  })

  it("hands back only this pairing's conversations, fenced to the pairing it read", async () => {
    const current = 'peerconv_0000000000c4'
    const replaced = 'peerconv_0000000000c5'
    open(current, SERVER.environmentId)
    db.db
      .prepare(
        `INSERT INTO peer_mail_conversations (conversation_id, role, peer_fingerprint, environment_id)
         VALUES (?, 'peer', 'fingerprint_replaced', ?)`
      )
      .run(replaced, SERVER.environmentId)
    queue(current, 'msg_current')
    queue(replaced, 'msg_replaced')

    await flushPairedServerReturns(runtime, { ...SERVER, pairingRevision: 3 })

    expect(pages).toEqual([['msg_current']])
    expect(vi.mocked(runtime.callOrchestrationWorkerServer).mock.calls[0]![5]).toEqual({
      expectedEnvironmentPairingRevision: 3
    })
    expect(db.listPendingFederationRelay(replaced, 'to_home')).toHaveLength(1)
  })

  it("never returns or retires a Dispatch's reports filed under a conversation an older build kept", async () => {
    const dispatchId = 'ctx_0000000000d2'
    const conversation = 'peerconv_0000000000c6'
    open(dispatchId, SERVER.environmentId)
    open(conversation, SERVER.environmentId)
    queue(dispatchId, 'msg_worker_report')
    queue(conversation, 'msg_reply')
    answer = () => ({ acknowledgments: [], gone: [] })

    await flushPairedServerReturns(runtime, SERVER)
    retirePairedServerRoute(runtime, SERVER.environmentId)

    expect(pages).toEqual([['msg_reply']])
    expect(db.listPendingFederationRelay(conversation, 'to_home')).toEqual([])
    expect(db.listPendingFederationRelay(dispatchId, 'to_home')).toHaveLength(1)
  })

  it("queues no reply or notice under a stored conversation that has a Dispatch's id", () => {
    const dispatchId = 'ctx_0000000000d3'
    open(dispatchId, SERVER.environmentId)

    expect(() =>
      queuePeerMailReply(db, dispatchId, 'msg_reply_into_dispatch', {
        senderLabel: 'Docs',
        fromAddress: 'bot:docs',
        subject: 'Re: Hi',
        body: 'Here.',
        threadId: null
      })
    ).toThrow(/not one this Orca can answer over/)
    expect(db.listPendingFederationRelay(dispatchId, 'to_home')).toEqual([])
  })

  it("lets no paired computer acknowledge a Dispatch's reports through a stored conversation under its id", async () => {
    const dispatchId = 'ctx_0000000000d4'
    db.db
      .prepare(
        `INSERT INTO peer_mail_conversations (conversation_id, role, peer_fingerprint, environment_id)
         VALUES (?, 'peer', 'fingerprint_client', NULL)`
      )
      .run(dispatchId)
    queue(dispatchId, 'msg_worker_report')
    const ack = ORCHESTRATION_PEER_MAIL_METHODS.find(
      (method) => method.name === 'orchestration.peerMailAck'
    )!

    await ack.handler(
      { acknowledgments: [{ conversationId: dispatchId, throughSequence: 1 }] },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the ack handler reads.
      {
        runtime,
        clientKind: 'runtime',
        pairedDeviceId: 'device_c',
        authenticatedCallerFingerprint: 'fingerprint_client'
      } as unknown as RpcContext
    )

    expect(db.listPendingFederationRelay(dispatchId, 'to_home')).toHaveLength(1)
  })

  it('settles what an older pairing owes once the server sees this computer under a new one', () => {
    const current = 'peerconv_0000000000c7'
    const replaced = 'peerconv_0000000000c8'
    db.db
      .prepare(
        `INSERT INTO peer_mail_conversations (conversation_id, role, peer_fingerprint, environment_id)
         VALUES (?, 'peer', 'fingerprint_replaced', ?)`
      )
      .run(replaced, SERVER.environmentId)
    open(current, SERVER.environmentId)
    queue(current, 'msg_current')
    queue(replaced, 'msg_replaced')
    const announced = { ...SERVER, wire: { ...SERVER.wire } }

    noteAnnounced(db, { ...announced, pairing: 'fingerprint_replaced' }, 'seen_as_a')
    expect(db.listPendingFederationRelay(replaced, 'to_home')).toHaveLength(1)

    db.db.exec(`
      CREATE TRIGGER fail_reply_settlement BEFORE UPDATE OF acked_at ON federation_relay_items
      WHEN OLD.message_id = 'msg_replaced'
      BEGIN SELECT RAISE(ABORT, 'reply settlement failed'); END;
    `)
    expect(() => noteAnnounced(db, announced, 'seen_as_a2')).toThrow('reply settlement failed')
    expect(owesAnnouncement(db, announced)).toBe(true)

    db.db.exec('DROP TRIGGER fail_reply_settlement')
    noteAnnounced(db, announced, 'seen_as_a2')

    expect(db.listPendingFederationRelay(replaced, 'to_home')).toEqual([])
    expect(db.listPendingFederationRelay(current, 'to_home')).toHaveLength(1)
  })

  it('refuses a reply to an admitted ask after the server pairing changes', async () => {
    const conversationId = 'peerconv_0000000000cb'
    open(conversationId, SERVER.environmentId)
    const original = db.insertMessage({ from: 'Ranger', to: 'term_docs', subject: 'Install guide' })
    db.linkPeerMailMessage({
      conversationId,
      peerFingerprint: SERVER.pairing,
      messageId: original.id,
      senderLabel: original.from_handle,
      environmentId: SERVER.environmentId
    })
    runtime.resolveOrchestrationWorkerServer = async () => ({
      environmentId: SERVER.environmentId,
      name: SERVER.serverName,
      peerFingerprint: SERVER.serverKey,
      homePeerFingerprint: 'fingerprint_replaced'
    })

    await expect(
      replyOverPeerMail({
        runtime,
        original,
        route: db.getPeerMailMessage(original.id)!,
        params: { body: 'docs/install.md' },
        orchestrationCaller: undefined,
        orchestrationMutation: undefined,
        recordMutationReceipt: undefined
      })
    ).rejects.toMatchObject({ code: 'request_mismatch' })
    expect(db.listPendingFederationRelay(conversationId, 'to_home')).toEqual([])
  })

  it("declines unread an approved ask an older build kept under a Dispatch's id, queuing nothing there", async () => {
    const dispatchId = 'ctx_0000000000e1'
    open(dispatchId, SERVER.environmentId)
    holdPairedServerAsk(db, {
      message_id: 'm_stored',
      conversation_id: dispatchId,
      server_key: SERVER.serverKey,
      environment_id: SERVER.environmentId,
      root_session: 'orca_session_id:asker',
      bot_id: 'docs',
      payload: JSON.stringify({
        to: 'bot:docs',
        senderLabel: 'Ranger',
        subject: 'Hi',
        type: 'status',
        rootSession: 'orca_session_id:asker'
      }),
      state: 'admit'
    })

    await admitPairedServerAsks(runtime)

    expect(getPairedServerAsk(db, 'm_stored')).toBeUndefined()
    expect(db.getMessageById('m_stored')).toBeFalsy()
    expect(db.listPendingFederationRelay(dispatchId, 'to_home')).toEqual([])
  })
})
