import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it } from 'vitest'
import { NODE_RELAY_CLIENT_PLATFORM } from '../../../shared/remote-runtime/relay/client/node/node-relay-client-platform'
import { SharedBotHosts } from './shared-bot-hosts'
import type { SharedBotHostEntry } from './shared-bot-host-store'
import {
  ACCEPT_RETRY_MS,
  nextPairingStep,
  sendsHeld,
  withoutRefusedCredential,
  type MineShare
} from './shared-bot-pairing'
import type { SharedBotsCloud } from './shared-bots-cloud'
import type { ConnectorShareAcceptRequest } from '../../../../cloud/packages/connector-contract/src/share-messages'

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

function hosts(mine: () => MineShare[], now: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'shared-bot-hosts-'))
  dirs.push(dir)
  const accepts: [string, ConnectorShareAcceptRequest][] = []
  const cloud: SharedBotsCloud = {
    mine: async () => ({ ok: true, value: { v: 1, shares: mine() } }),
    accept: async (shareId, request) => {
      accepts.push([shareId, request])
      return { ok: true, value: { status: 'queued' } }
    },
    hold: async () => ({ ok: true, value: { status: 'held' } })
  }
  const published: string[][] = []
  const service = new SharedBotHosts({
    userDataPath: dir,
    cloud: () => cloud,
    platform: NODE_RELAY_CLIENT_PLATFORM,
    publish: (views) => published.push(views.map((view) => view.shareId)),
    now
  })
  return { service, accepts, published }
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
