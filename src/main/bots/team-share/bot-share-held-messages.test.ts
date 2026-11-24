import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { BotShare } from '../../../shared/bots/bot-team-shares'
import {
  sealBotTeamShareHeldMessage,
  type BotTeamShareHeldMessage
} from '../../../shared/bots/bot-team-share-seal'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import { OrchestrationDb } from '../../runtime/orchestration/db/orchestration-db'
import {
  BotShareDeviceStore,
  type BotShareDevice
} from '../../runtime/rpc/server/pairing/bot-share-device-store'
import { deliverBotShareHeldMessage, type BotShareHeldMessageDeps } from './bot-share-held-messages'
import { openBotShareNewChat } from './bot-share-new-chats'

// The real seal, device store and receipt ledger; only the RPC calls the message runs as are faked,
// standing in for the dispatcher that admits them as the device's socket calls would be.

const host = nacl.box.keyPair()
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const hostKeypair = { publicKeyB64: b64(host.publicKey), secretKey: host.secretKey }

const alice: BotShare = {
  kind: 'account',
  shareId: 'share-alice',
  accountId: 'acct-alice',
  name: 'Alice',
  email: 'alice@example.com',
  addedAt: 1
}

const Params = z.record(z.string(), z.unknown())
const Envelope = z.object({ sessionId: z.string(), clientOperationId: z.string() })

type Call = { deviceId: string; method: string; params: Record<string, unknown> }

let dir: string
let db: OrchestrationDb
let store: BotShareDeviceStore
let aliceKeys: nacl.SignKeyPair
let aliceDevice: BotShareDevice
let shares: BotShare[]
let calls: Call[]
let journal: Set<string>
let chats: number

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-held-'))
  db = new OrchestrationDb(join(dir, 'orchestration.db'))
  store = new BotShareDeviceStore(dir)
  aliceKeys = nacl.sign.keyPair()
  aliceDevice = await store.add({
    botId: 'bot-1',
    accountId: 'acct-alice',
    name: 'Alice',
    scope: 'runtime',
    devicePublicKeyB64: b64(aliceKeys.publicKey)
  })
  shares = [alice]
  calls = []
  journal = new Set()
  chats = 0
})

afterEach(() => {
  db.close()
})

function deps(): BotShareHeldMessageDeps {
  return {
    hostKeypair,
    bots: { list: () => [{ id: 'bot-1', shares }] },
    devices: store,
    call: async (device, method, params) => {
      const call = { deviceId: device.deviceId, method, params: Params.parse(params) }
      calls.push(call)
      switch (method) {
        case 'bots.session.start':
          return { sessionId: `chat-${++chats}` }
        case 'agentSession.item':
          return {
            item: journal.has(`${String(call.params.sessionId)}|${String(call.params.itemId)}`)
              ? {}
              : null
          }
        case 'agentSessionAttachment.uploadStart':
          return { uploadId: 'upload-1' }
        case 'agentSessionAttachment.uploadCommit':
          return { path: '/attachments/shot.png', name: 'shot.png', byteLength: 4 }
        case 'agentSession.send': {
          const envelope = Envelope.parse(call.params.envelope)
          journal.add(
            `${envelope.sessionId}|${agentJournalSubmissionKey(envelope.clientOperationId)}`
          )
          return { ok: true, value: {} }
        }
        default:
          return {}
      }
    },
    fence: () => 1,
    newChat: (key, start) => openBotShareNewChat(db, key, start)
  }
}

function message(overrides: Partial<BotTeamShareHeldMessage> = {}): BotTeamShareHeldMessage {
  return {
    v: 1,
    shareId: 'share-alice',
    botId: 'bot-1',
    chat: { newChatId: 'new-1' },
    clientMessageId: 'msg-1',
    text: 'Can you check the build?',
    attachments: [],
    sentAt: 1,
    devicePublicKey: b64(aliceKeys.publicKey),
    ...overrides
  }
}

async function delivery(
  held: BotTeamShareHeldMessage,
  signer: nacl.SignKeyPair = aliceKeys,
  fields: { accountId?: string } = {}
) {
  return {
    kind: 'share_send' as const,
    deliveryId: `d-${held.clientMessageId}`,
    expiresAt: 10,
    conversation: { source: 'orca' as const, externalId: held.shareId },
    shareId: held.shareId,
    botId: held.botId,
    accountId: fields.accountId ?? 'acct-alice',
    clientMessageId: held.clientMessageId,
    sealed: await sealBotTeamShareHeldMessage(NODE_PAIRED_E2EE_PRIMITIVES, {
      hostKey: hostKeypair.publicKeyB64,
      message: held,
      sign: async (bytes) => nacl.sign.detached(bytes, signer.secretKey)
    })
  }
}

const sends = () => calls.filter((call) => call.method === 'agentSession.send')

describe('a held message on the host', () => {
  it('opens one new chat per new-chat id and sends each message there as the signing device', async () => {
    expect(await deliverBotShareHeldMessage(deps(), await delivery(message()))).toEqual({
      outcome: 'accepted'
    })
    const next = message({ clientMessageId: 'msg-2', text: 'and the tests' })
    expect(await deliverBotShareHeldMessage(deps(), await delivery(next))).toEqual({
      outcome: 'accepted'
    })
    expect(calls.filter((call) => call.method === 'bots.session.start')).toHaveLength(1)
    expect(sends().map((call) => call.params.envelope)).toEqual([
      expect.objectContaining({ sessionId: 'chat-1', clientOperationId: 'msg-1' }),
      expect.objectContaining({ sessionId: 'chat-1', clientOperationId: 'msg-2' })
    ])
    // Every call runs as Alice's own share device row, never as anyone the payload names.
    expect(new Set(calls.map((call) => call.deviceId))).toEqual(new Set([aliceDevice.deviceId]))
  })

  it('accepts a message already in the journal without sending it again', async () => {
    const held = await delivery(message({ chat: { sessionId: 'chat-own' } }))
    journal.add(`chat-own|${agentJournalSubmissionKey('msg-1')}`)
    expect(await deliverBotShareHeldMessage(deps(), held)).toEqual({ outcome: 'accepted' })
    expect(sends()).toEqual([])
  })

  it('stages attachments in the chat store and sends them by its path', async () => {
    const attachments = [{ name: 'shot.png', contentBase64: b64(new Uint8Array([1, 2, 3, 4])) }]
    await deliverBotShareHeldMessage(deps(), await delivery(message({ attachments })))
    expect(calls.map((call) => call.method)).toEqual([
      'bots.session.start',
      'agentSession.item',
      'agentSessionAttachment.uploadStart',
      'agentSessionAttachment.uploadAppend',
      'agentSessionAttachment.uploadCommit',
      'agentSession.send'
    ])
    expect(sends()[0]?.params.body).toMatchObject({
      blocks: [
        { type: 'text', text: 'Can you check the build?' },
        { type: 'image-ref', path: '/attachments/shot.png' }
      ]
    })
  })

  it('refuses one another key signed, or one sealed to another host', async () => {
    const forged = await delivery(message(), nacl.sign.keyPair())
    expect(await deliverBotShareHeldMessage(deps(), forged)).toEqual({
      outcome: 'refused',
      reason: 'bad_signature'
    })
    const elsewhere = { ...deps(), hostKeypair: { ...hostKeypair, secretKey: new Uint8Array(32) } }
    expect(await deliverBotShareHeldMessage(elsewhere, await delivery(message()))).toEqual({
      outcome: 'refused',
      reason: 'bad_signature'
    })
    expect(calls).toEqual([])
  })

  it('refuses a key that is no share device of that teammate on that bot', async () => {
    const stranger = nacl.sign.keyPair()
    const unknown = message({ devicePublicKey: b64(stranger.publicKey) })
    expect(await deliverBotShareHeldMessage(deps(), await delivery(unknown, stranger))).toEqual({
      outcome: 'refused',
      reason: 'unknown_device'
    })
    // Bob's own device, signing a message on Alice's share: the row, not the payload, says whose.
    const bob = nacl.sign.keyPair()
    await store.add({
      botId: 'bot-1',
      accountId: 'acct-bob',
      name: 'Bob',
      scope: 'runtime',
      devicePublicKeyB64: b64(bob.publicKey)
    })
    const asBob = message({ devicePublicKey: b64(bob.publicKey) })
    expect(await deliverBotShareHeldMessage(deps(), await delivery(asBob, bob))).toEqual({
      outcome: 'refused',
      reason: 'unknown_device'
    })
    await store.remove(aliceDevice.deviceId)
    expect(await deliverBotShareHeldMessage(deps(), await delivery(message()))).toEqual({
      outcome: 'refused',
      reason: 'unknown_device'
    })
    expect(calls).toEqual([])
  })

  it('refuses once the share is removed, or is not that account’s', async () => {
    const otherAccount = await delivery(message(), aliceKeys, { accountId: 'acct-bob' })
    expect(await deliverBotShareHeldMessage(deps(), otherAccount)).toEqual({
      outcome: 'refused',
      reason: 'unknown_share'
    })
    shares = []
    expect(await deliverBotShareHeldMessage(deps(), await delivery(message()))).toEqual({
      outcome: 'refused',
      reason: 'unknown_share'
    })
    expect(calls).toEqual([])
  })

  it('refuses a send the chat refuses, with its reason', async () => {
    const refusing: BotShareHeldMessageDeps = {
      ...deps(),
      call: async (device, method, params) =>
        method === 'agentSession.send'
          ? { ok: false, refusal: { code: 'agent_session_operation_invalid' } }
          : deps().call(device, method, params)
    }
    expect(await deliverBotShareHeldMessage(refusing, await delivery(message()))).toEqual({
      outcome: 'refused',
      reason: 'agent_session_operation_invalid'
    })
  })
})

describe('the new-chat ledger', () => {
  it('starts a chat for an id it has no record of, as on a database from before it kept any', async () => {
    let started = 0
    const start = async () => `chat-${++started}`
    const key = { shareId: 'share-alice', newChatId: 'new-1' }
    expect(await openBotShareNewChat(db, key, start)).toBe('chat-1')
    // Kept across a restart: the same database file, opened again.
    db.close()
    db = new OrchestrationDb(join(dir, 'orchestration.db'))
    expect(await openBotShareNewChat(db, key, start)).toBe('chat-1')
    expect(started).toBe(1)
  })

  it('starts again after a start that failed, leaving no record', async () => {
    const key = { shareId: 'share-alice', newChatId: 'new-1' }
    await expect(
      openBotShareNewChat(db, key, async () => {
        throw new Error('bot_not_found')
      })
    ).rejects.toThrow('bot_not_found')
    expect(await openBotShareNewChat(db, key, async () => 'chat-2')).toBe('chat-2')
  })
})
