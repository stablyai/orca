import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it } from 'vitest'
import { NODE_RELAY_CLIENT_PLATFORM } from '../../../shared/remote-runtime/relay/client/node/node-relay-client-platform'
import { SharedBotHosts } from './shared-bot-hosts'
import { UNREADABLE_ANSWER } from '../../connector-cloud/connector-cloud-request'
import { SharedBotHeldSends } from './shared-bot-held-sends'
import { SharedBotHostStore } from './shared-bot-host-store'
import { SHARED_BOT_HOST_ERRORS } from '../../../shared/bots/shared-bot-hosts'
import { structuredAgentSessionMessageSendMutation } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { SharedBotHostEntry } from './shared-bot-host-store'
import {
  ACCEPT_RETRY_MS,
  nextPairingStep,
  sendsHeld,
  withoutRefusedCredential,
  type MineShare
} from './shared-bot-pairing'
import type { SharedBotsCloud } from './shared-bots-cloud'
import type { ConnectorShareAcceptRequest } from '../../../shared/connector-share-contract'

const HOST_KEY = Buffer.from(nacl.box.keyPair().publicKey).toString('base64')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function share(overrides: Partial<MineShare> = {}): MineShare {
  return {
    shareId: 'share-1',
    botId: 'bot-1',
    botName: 'Ivy',
    ownerName: 'Jinwoo Hong',
    hostOnline: true,
    state: 'needs-accept',
    held: [],
    ...overrides
  }
}

function entry(overrides: Partial<SharedBotHostEntry> = {}): SharedBotHostEntry {
  return {
    shareId: 'share-1',
    environmentId: 'env-1',
    botId: 'bot-1',
    botName: 'Ivy',
    ownerName: 'Jinwoo Hong',
    deviceKey: { publicKeyB64: 'd', secretKeyB64: 'd' },
    sealKey: { publicKeyB64: 's', secretKeyB64: 's' },
    held: [],
    ...overrides
  }
}

const offer = (inviteExpiresAt: number): NonNullable<SharedBotHostEntry['offer']> => ({
  v: 1,
  relay: {
    v: 1,
    directorUrl: 'https://director.example',
    cellUrl: 'https://cell.example',
    assignmentEpoch: 1,
    relayHostId: 'AbCdEf0123_-xyZ9',
    inviteToken: 'i'.repeat(43),
    e2eeFraming: 2,
    inviteExpiresAt
  },
  hostPublicKeyB64: HOST_KEY,
  deviceId: 'device-1',
  botId: 'bot-1'
})

function hosts(
  mine: () => MineShare[] | Promise<MineShare[]>,
  now: () => number,
  hold: SharedBotsCloud['hold'] = async () => ({ ok: true, value: { status: 'held' } })
) {
  const dir = mkdtempSync(join(tmpdir(), 'shared-bot-hosts-'))
  dirs.push(dir)
  const accepts: [string, ConnectorShareAcceptRequest][] = []
  let mineReads = 0
  const cloud: SharedBotsCloud = {
    mine: async () => {
      mineReads += 1
      return { ok: true, value: { v: 1, shares: await mine() } }
    },
    accept: async (shareId, request) => {
      accepts.push([shareId, request])
      return { ok: true, value: { status: 'queued' } }
    },
    hold
  }
  const published: string[][] = []
  const service = new SharedBotHosts({
    userDataPath: dir,
    cloud: () => cloud,
    platform: NODE_RELAY_CLIENT_PLATFORM,
    publish: (views) => published.push(views.map((view) => view.shareId)),
    now
  })
  return { service, accepts, published, mineReads: () => mineReads }
}

describe('shared agent pairing', () => {
  it('lists exactly the shares the cloud says are this account’s', async () => {
    let shares = [share(), share({ shareId: 'share-2', botId: 'bot-2' })]
    const { service, published } = hosts(
      () => shares,
      () => 0
    )
    await service.refresh()
    expect(published.at(-1)).toEqual(['share-1', 'share-2'])
    shares = [share({ shareId: 'share-2', botId: 'bot-2' })]
    await service.refresh()
    service.stop()
    expect(published.at(-1)).toEqual(['share-2'])
  })

  it('accepts again with the same device keys once the invite expired and the host is back', async () => {
    let now = 1_000
    let online = true
    const { service, accepts } = hosts(
      () => [share({ hostOnline: online })],
      () => now
    )
    await service.refresh()
    online = false
    now += ACCEPT_RETRY_MS + 1
    await service.refresh()
    expect(accepts).toHaveLength(1)
    online = true
    await service.refresh()
    service.stop()
    expect(accepts).toHaveLength(2)
    const [first, second] = accepts
    expect(second).toEqual(first)
  })

  it('never dials an invite that is past its expiry or that the relay refused', () => {
    const live = entry({ offer: offer(10), acceptedAt: 0 })
    expect(nextPairingStep(live, share(), 5).kind).toBe('connect')
    expect(nextPairingStep(live, share(), 10 + ACCEPT_RETRY_MS)).toEqual({ kind: 'accept' })
    const refused = withoutRefusedCredential(live, { kind: 'invite', inviteToken: 'i'.repeat(43) })
    expect(nextPairingStep(refused, share({ hostOnline: false }), 5)).toEqual({ kind: 'wait' })
    expect(refused.offer?.deviceId).toBe('device-1')
  })
})

describe('where a message to a shared agent goes', () => {
  const chat = { sessionId: 'chat-1' }
  const noStates = new Map()

  it('hands off to the held queue when the host is away or the device is not paired yet', () => {
    expect(sendsHeld(entry({ hostKey: HOST_KEY }), 'offline', chat, noStates)).toBe(true)
    expect(sendsHeld(entry({ hostKey: HOST_KEY }), 'unpaired', { newChatId: 'n1' }, noStates)).toBe(
      true
    )
    expect(sendsHeld(entry({ hostKey: HOST_KEY }), 'live', chat, noStates)).toBe(false)
  })

  it('holds nothing for a host that published no key', () => {
    expect(sendsHeld(entry(), 'offline', chat, noStates)).toBe(false)
  })

  it('keeps a chat’s follow-ups on the held queue until its first held message lands', () => {
    const held = entry({
      hostKey: HOST_KEY,
      held: [{ clientMessageId: 'm1', chat, sentAt: 0 }]
    })
    expect(sendsHeld(held, 'live', chat, new Map([['m1', 'waiting' as const]]))).toBe(true)
    expect(sendsHeld(held, 'live', { sessionId: 'chat-2' }, noStates)).toBe(false)
    expect(sendsHeld(held, 'live', chat, new Map([['m1', 'delivered' as const]]))).toBe(false)
    expect(sendsHeld(held, 'live', chat, new Map([['m1', 'not_sent' as const]]))).toBe(false)
  })
})

const sendParams = (sessionId: string, clientOperationId: string) =>
  structuredAgentSessionMessageSendMutation({
    sessionId,
    clientOperationId,
    expectedRuntimeFence: null,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }
  })

describe('the held queue’s order', () => {
  it('keeps a message held while an older read of the cloud was out, and reads once more after it', async () => {
    let now = 1_000
    let release: (shares: MineShare[]) => void = () => {}
    let reads = 0
    const away = share({ hostOnline: false, hostKey: HOST_KEY })
    const { service, mineReads } = hosts(
      () => {
        reads += 1
        if (reads === 2) {
          return new Promise<MineShare[]>((resolve) => {
            release = resolve
          })
        }
        return reads === 1
          ? [away]
          : [{ ...away, held: [{ clientMessageId: 'm1', state: 'waiting' }] }]
      },
      () => now
    )
    await service.refresh()
    const reading = service.refresh()
    await new Promise((resolve) => setTimeout(resolve, 0))
    now = 2_000
    const sent = await service.call(
      service.views()[0]!.environmentId,
      'agentSession.send',
      sendParams('chat-0001', 'm1')
    )
    expect(sent.ok ? null : sent.error.code).toBe(SHARED_BOT_HOST_ERRORS.held)
    // The older read lands without m1; m1 stays, and one more read follows it.
    release([away])
    await reading
    service.stop()
    expect(mineReads()).toBe(3)
    expect(service['store'].get('share-1')?.held.map((held) => held.clientMessageId)).toEqual([
      'm1'
    ])
  })

  it('never sends live a message that belongs behind one still waiting, even when it can’t be held', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-bot-held-'))
    dirs.push(dir)
    const store = new SharedBotHostStore(dir)
    await store.load()
    const held = new SharedBotHeldSends({
      store,
      cloud: () => ({
        mine: async () => UNREADABLE_ANSWER,
        accept: async () => UNREADABLE_ANSWER,
        hold: async () => UNREADABLE_ANSWER
      }),
      now: () => 0,
      changed: () => {}
    })
    const waiting = entry({
      hostKey: HOST_KEY,
      deviceKey: {
        publicKeyB64: Buffer.from(nacl.sign.keyPair().publicKey).toString('base64'),
        secretKeyB64: Buffer.from(nacl.sign.keyPair().secretKey).toString('base64')
      },
      held: [{ clientMessageId: 'm1', chat: { sessionId: 'chat-0001' }, sentAt: 0 }]
    })
    const answer = await held.send(waiting, 'live', sendParams('chat-0001', 'm2'))
    expect(answer?.ok).toBe(false)
    expect(await held.send(waiting, 'live', sendParams('chat-0002', 'm3'))).toBeNull()
  })
})

describe('a held message and a cloud read that cross', () => {
  it('keeps a message held while a read was out until a read lists it, then drops it once one doesn’t', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-bot-cross-'))
    dirs.push(dir)
    const store = new SharedBotHostStore(dir)
    await store.load()
    const device = nacl.sign.keyPair()
    store.put(
      entry({
        hostKey: HOST_KEY,
        deviceKey: {
          publicKeyB64: Buffer.from(device.publicKey).toString('base64'),
          secretKeyB64: Buffer.from(device.secretKey).toString('base64')
        }
      })
    )
    let accept: () => void = () => {}
    const held = new SharedBotHeldSends({
      store,
      cloud: () => ({
        mine: async () => UNREADABLE_ANSWER,
        accept: async () => UNREADABLE_ANSWER,
        hold: () =>
          new Promise((resolve) => {
            accept = () => resolve({ ok: true, value: { status: 'held' } })
          })
      }),
      now: () => 5,
      changed: () => {}
    })
    // A read that doesn't list m1 lands on the share; it either crosses the hold or follows it.
    const read = (listed: MineShare['held']): void => {
      held.applyMine([share({ hostKey: HOST_KEY, held: listed })])
      const current = store.get('share-1')!
      store.put({ ...current, held: held.settle(current.held) })
    }
    const sending = held.send(store.get('share-1')!, 'offline', sendParams('chat-0001', 'm1'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    read([])
    accept()
    await sending
    read([])
    const ids = () => store.get('share-1')!.held.map((message) => message.clientMessageId)
    expect(ids()).toEqual(['m1'])
    read([{ clientMessageId: 'm1', state: 'waiting' }])
    expect(store.get('share-1')!.held[0]?.listed).toBe(true)
    read([])
    expect(ids()).toEqual([])
  })
})
