import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NODE_RELAY_CLIENT_PLATFORM } from '../../../shared/remote-runtime/relay/client/node/node-relay-client-platform'
import { SharedBotHosts } from './shared-bot-hosts'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { UNREADABLE_ANSWER } from '../../connector-cloud/connector-cloud-request'
import { SharedBotHeldSends } from './shared-bot-held-sends'
import { SharedBotHeldUploads } from './shared-bot-held-uploads'
import { SendParams } from '../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import { SHARED_BOT_HOSTS_FILENAME, SharedBotHostStore } from './shared-bot-host-store'
import {
  isSharedBotNewChatId,
  SHARED_BOT_HOST_ERRORS,
  SHARED_BOT_UNSHARED_MESSAGE,
  SHARED_HOSTS_HOLD_WHILE_AWAY,
  type SharedBotHostView
} from '../../../shared/bots/shared-bot-hosts'
import {
  openBotTeamShareHeldMessage,
  sealBotTeamShareOffer
} from '../../../shared/bots/bot-team-share-seal'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import { structuredAgentSessionMessageSendMutation } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { SharedBotHostEntry } from './shared-bot-host-store'
import { ACCEPT_RETRY_MS, nextPairingStep, sendsHeld, type MineShare } from './shared-bot-pairing'
import { withoutRefusedCredential } from '../../../shared/remote-runtime/relay/client/shared-host-relay-link'
import type { SharedBotsCloud } from './shared-bots-cloud'
import { memorySharedBotHomes } from './shared-bot-home.test-fixture'
import type {
  ConnectorShareAcceptRequest,
  ConnectorShareHoldRequest
} from '../../../shared/connector-share-contract'

// Held sends are off while SHARED_HOSTS_HOLD_WHILE_AWAY is: their tests run again when it is on.
const heldIt = it.skipIf(!SHARED_HOSTS_HOLD_WHILE_AWAY)

const HOST = nacl.box.keyPair()
const HOST_KEY = Buffer.from(HOST.publicKey).toString('base64')
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
    phones: [],
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
  hold: SharedBotsCloud['hold'] = async () => ({ ok: true, value: { status: 'held' } }),
  phoneSharesChanged?: () => void
) {
  const holds: [string, ConnectorShareHoldRequest][] = []
  const dir = mkdtempSync(join(tmpdir(), 'shared-bot-hosts-'))
  dirs.push(dir)
  const accepts: [string, ConnectorShareAcceptRequest][] = []
  let mineReads = 0
  // As the cloud does, a read lists every message it has taken, waiting unless `mine` says more.
  const taken: [string, string][] = []
  const cloud: SharedBotsCloud = {
    mine: async () => {
      mineReads += 1
      const shares = (await mine()).map((listed) => ({
        ...listed,
        held: [
          ...listed.held,
          ...taken
            .filter(
              ([shareId, id]) =>
                shareId === listed.shareId &&
                !listed.held.some((message) => message.clientMessageId === id)
            )
            .map(([, clientMessageId]) => ({ clientMessageId, state: 'waiting' as const }))
        ]
      }))
      return { ok: true, value: { v: 1, shares } }
    },
    accept: async (shareId, request) => {
      accepts.push([shareId, request])
      return { ok: true, value: { status: 'queued' } }
    },
    hold: async (shareId, request) => {
      holds.push([shareId, request])
      const answer = await hold(shareId, request)
      if (answer.ok) {
        taken.push([shareId, request.clientMessageId])
      }
      return answer
    }
  }
  const published: string[][] = []
  const memory = memorySharedBotHomes(dir)
  const service = new SharedBotHosts({
    userDataPath: dir,
    account: () => 'ada',
    cloud: () => cloud,
    platform: NODE_RELAY_CLIENT_PLATFORM,
    // As the desktop's publish does (ipc/shared-bot-hosts.ts).
    publish: (state) => {
      published.push(state.hosts.map((view) => view.shareId))
      service.phones.noteListed(phoneSharesChanged)
    },
    homes: memory.homes,
    now
  })
  return { service, accepts, holds, published, mineReads: () => mineReads, dir, memory }
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

  it('tells its phone through botsChanged of a share it reached, with no bots of its own', async () => {
    const runtime = new OrcaRuntimeService()
    expect(runtime.bots.list()).toEqual([])
    const events: unknown[] = []
    runtime.onClientEvent((event) => void (event.type === 'botsChanged' && events.push(event)))
    const primitives = NODE_PAIRED_E2EE_PRIMITIVES
    const hostKey = primitives.publicKeyToBase64(primitives.generateKeyPair().publicKey)
    let current = share({ state: 'ready', hostKey })
    const { service } = hosts(
      () => [current],
      () => 1_000,
      undefined,
      () => runtime.notifySharedBotsChanged()
    )
    await service.refresh()
    // Listed but not reached: the phone can't get a key to it yet, so its list is unchanged.
    expect(service.phones.phoneShares().shares).toEqual([])
    const { deviceKey, sealKey } = service.store.get('share-1')!
    // Expired invite, so nothing dials the relay.
    const sealedOffer = sealBotTeamShareOffer(primitives, {
      sealKey: sealKey.publicKeyB64,
      offer: { ...offer(0), hostPublicKeyB64: hostKey }
    })
    current = { ...current, offers: [{ devicePublicKey: deviceKey.publicKeyB64, sealedOffer }] }
    await service.refresh()
    service.stop()
    expect(service.phones.phoneShares().shares.map((listed) => listed.shareId)).toEqual(['share-1'])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual([{ type: 'botsChanged', kinds: ['bot'] }])
  })

  it('answers no longer shared while the cloud read that drops a share is out, and after', async () => {
    let answer: ((shares: MineShare[]) => void) | null = null
    let mine: () => MineShare[] | Promise<MineShare[]> = () => [share()]
    const { service } = hosts(
      () => mine(),
      () => 1_000
    )
    await service.refresh()
    const { environmentId } = service.views()[0]!
    mine = () => new Promise((resolve) => (answer = resolve))
    const read = service.refresh()
    const during = service.call(environmentId, 'bots.list', {})
    await vi.waitFor(() => expect(answer).not.toBeNull())
    answer!([])
    await read
    const answers = [await during, await service.call(environmentId, 'bots.list', {})]
    service.stop()
    const unshared = { code: SHARED_BOT_HOST_ERRORS.unshared, message: SHARED_BOT_UNSHARED_MESSAGE }
    expect(answers.map((response) => (response.ok ? null : response.error))).toEqual([
      unshared,
      unshared
    ])
    expect(service.reaches(environmentId)).toBe(true)
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

  heldIt(
    'hands off to the held queue when the host is away or the device is not paired yet',
    () => {
      expect(sendsHeld(entry({ hostKey: HOST_KEY }), 'offline', chat, noStates)).toBe(true)
      expect(
        sendsHeld(entry({ hostKey: HOST_KEY }), 'unpaired', { newChatId: 'n1' }, noStates)
      ).toBe(true)
      expect(sendsHeld(entry({ hostKey: HOST_KEY }), 'live', chat, noStates)).toBe(false)
    }
  )

  it('holds nothing for a host that published no key', () => {
    expect(sendsHeld(entry(), 'offline', chat, noStates)).toBe(false)
  })

  heldIt('keeps a chat’s follow-ups on the held queue until its first held message lands', () => {
    const held = entry({
      hostKey: HOST_KEY,
      held: [{ clientMessageId: 'm1', chat, text: 'hi', sentAt: 0 }]
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

describe('the key a held message is sealed to', () => {
  heldIt('stays the paired host’s own when the cloud later names or offers another', async () => {
    const primitives = NODE_PAIRED_E2EE_PRIMITIVES
    const host = primitives.generateKeyPair()
    const cloudKeys = primitives.generateKeyPair()
    const hostKey = primitives.publicKeyToBase64(host.publicKey)
    const cloudKey = primitives.publicKeyToBase64(cloudKeys.publicKey)
    const sealed: string[] = []
    let current = share({ state: 'ready', hostKey })
    const { service } = hosts(
      () => [current],
      () => 1_000,
      async (_shareId, request) => {
        sealed.push(request.sealed)
        return { ok: true, value: { status: 'held' } }
      }
    )
    await service.refresh()
    const { deviceKey, sealKey } = service['store'].get('share-1')!
    // Expired invites, so nothing dials the relay.
    const offered = (key: string) => [
      {
        devicePublicKey: deviceKey.publicKeyB64,
        sealedOffer: sealBotTeamShareOffer(primitives, {
          sealKey: sealKey.publicKeyB64,
          offer: { ...offer(0), hostPublicKeyB64: key }
        })
      }
    ]
    current = { ...current, offers: offered(hostKey) }
    await service.refresh()
    expect(service['store'].get('share-1')?.offer?.hostPublicKeyB64).toBe(hostKey)

    // The cloud knows the seal key, so it can name its own key and seal an offer under it too.
    current = { ...current, hostOnline: false, hostKey: cloudKey, offers: offered(cloudKey) }
    await service.refresh()
    const sent = await service.call(
      service.views()[0]!.environmentId,
      'agentSession.send',
      sendParams('chat-0001', 'm1')
    )
    service.stop()
    expect(sent.ok ? null : sent.error.code).toBe(SHARED_BOT_HOST_ERRORS.held)
    const open = (secretKey: Uint8Array, key: string) =>
      openBotTeamShareHeldMessage(primitives, {
        hostSecretKey: secretKey,
        hostKey: key,
        sealed: sealed[0]!,
        expect: { shareId: 'share-1', botId: 'bot-1', clientMessageId: 'm1' }
      })
    expect(open(cloudKeys.secretKey, cloudKey)).toBeNull()
    expect(open(host.secretKey, hostKey)?.text).toBe('hi')
  })
})

describe('the held queue’s order', () => {
  heldIt(
    'keeps a message held while an older read of the cloud was out, and reads once more after it',
    async () => {
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
    }
  )

  heldIt(
    'never sends live a message that belongs behind one still waiting, even when it can’t be held',
    async () => {
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
        held: [{ clientMessageId: 'm1', chat: { sessionId: 'chat-0001' }, text: 'hi', sentAt: 0 }]
      })
      const answer = await held.send(waiting, 'live', sendParams('chat-0001', 'm2'))
      expect(answer?.ok).toBe(false)
      expect(await held.send(waiting, 'live', sendParams('chat-0002', 'm3'))).toBeNull()
    }
  )
})

describe('a held message and a cloud read that cross', () => {
  heldIt(
    'keeps a message held while a read was out until a read lists it, then drops it once one doesn’t',
    async () => {
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
      // A cloud read: begun at one point, its answer applied later.
      const begin = () => {
        const read = held.beginRead()
        return (listed: MineShare['held']): void => {
          held.applyMine([share({ hostKey: HOST_KEY, held: listed })])
          const current = store.get('share-1')!
          store.put({ ...current, held: held.settle(current.held, read) })
        }
      }
      const sending = held.send(store.get('share-1')!, 'offline', sendParams('chat-0001', 'm1'))
      await new Promise((resolve) => setTimeout(resolve, 0))
      // Out while m1 was being held: its answer can't list it yet.
      const crossing = begin()
      accept()
      await sending
      crossing([])
      const ids = () => store.get('share-1')!.held.map((message) => message.clientMessageId)
      expect(ids()).toEqual(['m1'])
      begin()([{ clientMessageId: 'm1', state: 'waiting' }])
      expect(ids()).toEqual(['m1'])
      begin()([])
      expect(ids()).toEqual([])
    }
  )

  it('settles a message kept from an earlier run that the cloud no longer lists, so its chat goes live', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-bot-aged-'))
    dirs.push(dir)
    // Held, then Orca quit before any read listed it; the cloud aged it out meanwhile.
    const kept = entry({
      hostKey: HOST_KEY,
      held: [{ clientMessageId: 'm1', chat: { sessionId: 'chat-0001' }, text: 'Hi', sentAt: 0 }]
    })
    writeFileSync(join(dir, SHARED_BOT_HOSTS_FILENAME), JSON.stringify({ v: 1, shares: [kept] }))
    const service = new SharedBotHosts({
      userDataPath: dir,
      account: () => 'ada',
      cloud: () => ({
        mine: async () => ({ ok: true, value: { v: 1, shares: [share({ hostKey: HOST_KEY })] } }),
        accept: async () => ({ ok: true, value: { status: 'queued' } }),
        hold: async () => ({ ok: true, value: { status: 'held' } })
      }),
      platform: NODE_RELAY_CLIENT_PLATFORM,
      publish: () => {},
      homes: memorySharedBotHomes(dir).homes,
      now: () => 0
    })
    await service.refresh()
    service.stop()
    await service.flushed()
    const store = new SharedBotHostStore(dir)
    await store.load()
    const settled = store.get('share-1')!
    expect(settled.held).toEqual([])
    expect(sendsHeld(settled, 'live', { sessionId: 'chat-0001' }, new Map())).toBe(false)
  })
})

describe('a shared agent’s home on this computer', () => {
  function homeHosts(dir: string, memory: ReturnType<typeof memorySharedBotHomes>) {
    let shares: MineShare[] = [share(), share({ shareId: 'share-2', botId: 'bot-2' })]
    const views: SharedBotHostView[][] = []
    const service = new SharedBotHosts({
      userDataPath: dir,
      account: () => 'ada',
      cloud: () => ({
        mine: async () => ({ ok: true, value: { v: 1, shares } }),
        accept: async () => ({ ok: true, value: { status: 'queued' } }),
        hold: async () => ({ ok: true, value: { status: 'held' } })
      }),
      platform: NODE_RELAY_CLIENT_PLATFORM,
      publish: (next) => views.push(next.hosts),
      homes: memory.homes,
      now: () => 0
    })
    return {
      service,
      setShares: (next: MineShare[]) => (shares = next),
      homeOf: (shareId: string) =>
        views.at(-1)?.find((view) => view.shareId === shareId)?.homeWorkspaceId
    }
  }

  it('is one Bots-group folder workspace per share, kept across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-bot-home-'))
    dirs.push(dir)
    const memory = memorySharedBotHomes(dir)
    const first = homeHosts(dir, memory)
    await first.service.refresh()
    first.service.stop()
    await first.service.flushed()
    const home = first.homeOf('share-1')
    expect(memory.groups).toEqual([
      expect.objectContaining({ name: 'Bots', parentPath: join(dir, 'bots') })
    ])
    expect(memory.folders).toEqual([
      {
        id: home,
        name: 'Ivy',
        folderPath: join(dir, 'shared-agents', 'share-1'),
        projectGroupId: memory.groups[0]?.id
      },
      expect.objectContaining({ folderPath: join(dir, 'shared-agents', 'share-2') })
    ])
    expect(existsSync(join(dir, 'shared-agents', 'share-1'))).toBe(true)
    const restarted = homeHosts(dir, memory)
    await restarted.service.refresh()
    restarted.service.stop()
    expect(restarted.homeOf('share-1')).toBe(home)
    expect(memory.folders).toHaveLength(2)
  })

  it('loads a store written before homes, and makes each share its home', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-bot-home-old-'))
    dirs.push(dir)
    writeFileSync(join(dir, SHARED_BOT_HOSTS_FILENAME), JSON.stringify({ v: 1, shares: [entry()] }))
    const memory = memorySharedBotHomes(dir)
    const { service, homeOf } = homeHosts(dir, memory)
    await service.ready()
    expect(service.views()).toEqual([
      expect.objectContaining({ shareId: 'share-1', homeWorkspaceId: null })
    ])
    await service.refresh()
    service.stop()
    expect(service.views().find((view) => view.environmentId === 'env-1')?.homeWorkspaceId).toBe(
      homeOf('share-1')
    )
    expect(homeOf('share-1')).toEqual(expect.any(String))
  })

  it('goes with its share: the record, the workspace and only its own folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-bot-home-gone-'))
    dirs.push(dir)
    const memory = memorySharedBotHomes(dir)
    const { service, setShares, homeOf } = homeHosts(dir, memory)
    await service.refresh()
    const kept = homeOf('share-2')
    writeFileSync(join(dir, 'shared-agents', 'share-1', 'notes.md'), 'x')
    setShares([share({ shareId: 'share-2', botId: 'bot-2' })])
    await service.refresh()
    service.stop()
    expect(service.views().map((view) => view.shareId)).toEqual(['share-2'])
    expect(memory.folders.map((home) => home.id)).toEqual([kept])
    expect(existsSync(join(dir, 'shared-agents', 'share-1'))).toBe(false)
    expect(existsSync(join(dir, 'shared-agents', 'share-2'))).toBe(true)
    await service.flushed()
    const store = new SharedBotHostStore(dir)
    await store.load()
    expect(store.list().map((kept) => kept.shareId)).toEqual(['share-2'])
  })
})

const StartedChat = z.object({ sessionId: z.string() })

describe('a teammate’s messages while the shared agent’s computer is away', () => {
  const send = (sessionId: string, clientOperationId: string, text: string) =>
    structuredAgentSessionMessageSendMutation({
      sessionId,
      clientOperationId,
      expectedRuntimeFence: null,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
    })
  const away = (held: MineShare['held'] = []) => [
    share({ hostOnline: false, hostKey: HOST_KEY, held })
  ]

  heldIt(
    'starts a new chat as a placeholder whose first message is held for the host to start it',
    async () => {
      const { service, holds } = hosts(
        () => away(),
        () => 1_000
      )
      await service.refresh()
      const environmentId = service.views()[0]!.environmentId
      const started = await service.call(environmentId, 'bots.session.start', { botId: 'bot-1' })
      const sessionId = StartedChat.parse(started.ok ? started.result : null).sessionId
      expect(isSharedBotNewChatId(sessionId)).toBe(true)
      // The host doesn't know the placeholder: nothing of it is read there.
      const read = await service.call(environmentId, 'agentSession.history', { sessionId })
      expect(read.ok ? null : read.error.code).toBe(SHARED_BOT_HOST_ERRORS.offline)
      const sent = await service.call(
        environmentId,
        'agentSession.send',
        send(sessionId, 'm1', 'Hi')
      )
      service.stop()
      expect(sent.ok ? null : sent.error.code).toBe(SHARED_BOT_HOST_ERRORS.held)
      const opened = openBotTeamShareHeldMessage(NODE_PAIRED_E2EE_PRIMITIVES, {
        hostSecretKey: HOST.secretKey,
        hostKey: HOST_KEY,
        sealed: holds[0]![1].sealed,
        expect: { shareId: 'share-1', botId: 'bot-1', clientMessageId: 'm1' }
      })
      expect(opened?.chat).toEqual({ newChatId: sessionId })
      expect(service.views()[0]!.held).toEqual([
        {
          clientMessageId: 'm1',
          sessionId,
          text: 'Hi',
          attachments: [],
          sentAt: 1_000,
          state: 'waiting'
        }
      ])
    }
  )

  it('with held sends off, is away like a paired server: nothing held, listed or started', async () => {
    const { service, holds } = hosts(
      () => away([{ clientMessageId: 'old', state: 'waiting' }]),
      () => 1_000
    )
    await service.refresh()
    const view = service.views()[0]!
    expect(view).toMatchObject({ holds: false, held: [] })
    const started = await service.call(view.environmentId, 'bots.session.start', { botId: 'bot-1' })
    const sent = await service.call(
      view.environmentId,
      'agentSession.send',
      send('chat-1', 'm1', 'Hi')
    )
    service.stop()
    expect(started.ok ? null : started.error.code).toBe(SHARED_BOT_HOST_ERRORS.offline)
    expect(sent.ok ? null : sent.error.code).toBe(SHARED_BOT_HOST_ERRORS.offline)
    expect(holds).toEqual([])
  })

  it('starts no placeholder for a host that holds nothing', async () => {
    const { service } = hosts(
      () => [share({ hostOnline: false })],
      () => 0
    )
    await service.refresh()
    const started = await service.call(service.views()[0]!.environmentId, 'bots.session.start', {
      botId: 'bot-1'
    })
    service.stop()
    expect(started.ok ? null : started.error.code).toBe(SHARED_BOT_HOST_ERRORS.offline)
  })

  heldIt(
    'keeps a placeholder whose swap meets a dropped link, never minting another for it',
    async () => {
      const { service } = hosts(
        () => away(),
        () => 0
      )
      await service.refresh()
      const environmentId = service.views()[0]!.environmentId
      const started = await service.call(environmentId, 'bots.session.start', { botId: 'bot-1' })
      const placeholder = StartedChat.parse(started.ok ? started.result : null).sessionId
      const swap = await service.call(environmentId, 'bots.session.start', {
        botId: 'bot-1',
        newChatId: placeholder
      })
      service.stop()
      expect(swap.ok ? null : swap.error.code).toBe(SHARED_BOT_HOST_ERRORS.offline)
    }
  )

  heldIt('sends a refused message again under a new id, in its place', async () => {
    let held: MineShare['held'] = []
    const { service, holds } = hosts(
      () => away(held),
      () => 0
    )
    await service.refresh()
    const environmentId = service.views()[0]!.environmentId
    await service.call(environmentId, 'agentSession.send', send('chat-0001', 'm1', 'Check #40189'))
    expect(await service.sendAgain(environmentId, 'm1')).toBe(false)
    held = [{ clientMessageId: 'm1', state: 'not_sent' }]
    await service.refresh()
    expect(service.views()[0]!.held.map((message) => message.state)).toEqual(['not_sent'])
    expect(await service.sendAgain(environmentId, 'm1')).toBe(true)
    service.stop()
    const again = holds[1]![1].clientMessageId
    expect(again).not.toBe('m1')
    expect(service.views()[0]!.held).toEqual([
      {
        clientMessageId: again,
        sessionId: 'chat-0001',
        text: 'Check #40189',
        attachments: [],
        sentAt: 0,
        state: 'waiting'
      }
    ])
  })
})

describe('a new chat the host started from its placeholder id', () => {
  heldIt(
    'draws its held messages in the started chat, and keeps that chat’s follow-ups behind them',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'shared-bot-started-'))
      dirs.push(dir)
      const store = new SharedBotHostStore(dir)
      await store.load()
      const placeholder = entry({
        hostKey: HOST_KEY,
        held: [
          { clientMessageId: 'm1', chat: { newChatId: 'shared-new-1' }, text: 'hi', sentAt: 0 }
        ]
      })
      store.put(placeholder)
      let changed = 0
      const held = new SharedBotHeldSends({
        store,
        cloud: () => null,
        now: () => 0,
        changed: () => {
          changed += 1
        }
      })
      held.started(placeholder, 'shared-new-1', 'chat-real-01')
      const started = store.get('share-1')!
      expect(changed).toBe(1)
      expect(held.views(started).map((view) => view.sessionId)).toEqual(['chat-real-01'])
      expect(sendsHeld(started, 'live', { sessionId: 'chat-real-01' }, new Map())).toBe(true)
      expect(sendsHeld(started, 'live', { sessionId: 'chat-other-1' }, new Map())).toBe(false)
    }
  )
})

describe('attachments kept while the host was away, sent once it is back', () => {
  it('go to the host’s store first, and the send names them there', async () => {
    const uploads = new SharedBotHeldUploads()
    const ok = (result: unknown) => ({ id: 'x', ok: true as const, result })
    const started = uploads.call(
      'agentSessionAttachment.uploadStart',
      { sessionId: 'chat-0001', name: 'shot.png', byteLength: 3 },
      'Jinwoo Hong'
    )
    const { uploadId } = z.object({ uploadId: z.string() }).parse(started.ok && started.result)
    uploads.call(
      'agentSessionAttachment.uploadAppend',
      { uploadId, offset: 0, contentBase64: Buffer.from('png').toString('base64') },
      'Jinwoo Hong'
    )
    const committed = uploads.call(
      'agentSessionAttachment.uploadCommit',
      { uploadId },
      'Jinwoo Hong'
    )
    const keptPath = z.object({ path: z.string() }).parse(committed.ok && committed.result).path
    const sent: string[] = []
    let sendParams: unknown = null
    let hostTakesSend = false
    const send = () =>
      uploads.sendWithKept(
        structuredAgentSessionMessageSendMutation({
          sessionId: 'chat-0001',
          clientOperationId: 'm1',
          expectedRuntimeFence: null,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'image-ref', path: keptPath }] }
        }),
        async (method, params) => {
          sent.push(method)
          if (method === 'agentSession.send') {
            sendParams = params
            return hostTakesSend
              ? ok({})
              : { id: 'x', ok: false as const, error: { code: 'unavailable', message: 'gone' } }
          }
          return method === 'agentSessionAttachment.uploadStart'
            ? ok({ uploadId: 'host-upload' })
            : method === 'agentSessionAttachment.uploadCommit'
              ? ok({ path: '/host/attachments/shot.png', name: 'shot.png', byteLength: 3 })
              : ok({})
        }
      )
    // The host didn't take the send: the file stays here for the retry.
    await send()
    expect(sent).toEqual([
      'agentSessionAttachment.uploadStart',
      'agentSessionAttachment.uploadAppend',
      'agentSessionAttachment.uploadCommit',
      'agentSession.send'
    ])
    expect(SendParams.parse(sendParams).body.blocks).toEqual([
      { type: 'image-ref', path: '/host/attachments/shot.png' }
    ])
    expect(uploads.isKept(keptPath)).toBe(true)
    hostTakesSend = true
    expect((await send()).ok).toBe(true)
    expect(uploads.isKept(keptPath)).toBe(false)
  })
})
