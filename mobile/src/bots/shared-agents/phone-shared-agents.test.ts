// A page's call naming a shared agent's host goes over the phone's own path, not the computer: while
// the host is away a send is sealed to the pinned host key and held with the phone's share credential,
// later sends in that chat queue behind it, and once Orca Cloud says it landed they go live again.
import nacl from 'tweetnacl'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const appStorage = new Map<string, string>()
const keychain = new Map<string, string>()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => appStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => void appStorage.set(key, value)
  }
}))
vi.mock('../../host-credentials/pairing-keychain', () => ({
  readPairingKeychainItem: async (key: string) => keychain.get(key) ?? null,
  writePairingKeychainItem: async (key: string, value: string) => void keychain.set(key, value),
  deletePairingKeychainItem: async (key: string) => void keychain.delete(key)
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

import { SharedBotsPhoneProvisionParams } from '../../../../src/shared/bots/bot-share-phone'
import {
  openBotTeamShareHeldMessage,
  sealBotTeamShareOffer
} from '../../../../src/shared/bots/bot-team-share-seal'
import {
  SHARED_BOT_HOST_ERRORS,
  SHARED_HOSTS_HOLD_WHILE_AWAY
} from '../../../../src/shared/bots/shared-bot-hosts'

// Held sends are off while SHARED_HOSTS_HOLD_WHILE_AWAY is: their tests run again when it is on.
const heldIt = it.skipIf(!SHARED_HOSTS_HOLD_WHILE_AWAY)
import { structuredAgentSessionMessageSendMutation } from '../../../../src/shared/agent-session/requests/structured-agent-session-send-mutation'
import { hashRelayCredential } from '../../../../src/shared/remote-runtime/relay/relay-credential-hash'
import type { RpcResponse } from '../../../../src/shared/remote-runtime/rpc/rpc-response-shape'
import { MOBILE_PAIRED_E2EE_PRIMITIVES as PRIMITIVES } from '../../transport/encryption/mobile-paired-e2ee-primitives'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { HELD_WAIT_MS } from './phone-shared-agent-held'
import { PhoneSharedAgents } from './phone-shared-agents'
import { namesPhoneSharedAgent, routeSharedAgentCalls } from './shared-agent-call-routing'
import {
  createBridgeVerdictHold,
  type DesktopBound
} from '../../mobile-web-shell/host-bridge/bridge-host-verdict-hold'

const ConnectorShareHoldRequestBody = z.object({ sealed: z.string() })
const HOST = nacl.box.keyPair()
const HOST_KEY = PRIMITIVES.encodeBase64(HOST.publicKey)
const CHAT = '00000000-0000-4000-8000-000000000001'
const share = {
  shareId: 'share-1',
  botId: 'bot-1',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  environmentId: 'env-1'
}
const SHARED = { envelope: { executionHost: 'runtime:env-1' } }

/** The teammate's computer as the phone's paired host: its shares, a key per ask, and the page calls
 *  it should not get. */
function computer() {
  const asks: SharedBotsPhoneProvisionParams[] = []
  const desktopCalls: string[] = []
  const sendRequest = async (method: string, params?: unknown): Promise<RpcResponse> => {
    if (method === 'sharedBots.phone.list') {
      return { id: method, ok: true, result: { shares: [share] } }
    }
    if (method !== 'sharedBots.phone.provision') {
      desktopCalls.push(method)
      return { id: method, ok: true, result: {} }
    }
    const ask = SharedBotsPhoneProvisionParams.parse(params)
    asks.push(ask)
    const offer = {
      v: 1 as const,
      relay: {
        v: 1 as const,
        directorUrl: 'https://director.example',
        cellUrl: 'https://cell.example',
        assignmentEpoch: 1,
        relayHostId: 'AbCdEf0123_-xyZ9',
        inviteToken: 'i'.repeat(43),
        e2eeFraming: 2 as const,
        // Lapsed: the phone never dials it here, so the host is away for this test.
        inviteExpiresAt: 10
      },
      hostPublicKeyB64: HOST_KEY,
      deviceId: 'phone-key-1',
      botId: 'bot-1'
    }
    const result = {
      v: 1,
      ...share,
      connectorOrigin: 'https://cloud.example',
      hostKey: HOST_KEY,
      sealedOffer: sealBotTeamShareOffer(PRIMITIVES, { sealKey: ask.sealKey, offer })
    }
    return { id: method, ok: true, result }
  }
  return { asks, desktopCalls, client: { sendRequest } }
}

type CloudCall = { url: string; method: string; authorization: string; body: unknown }

/** Orca Cloud's share endpoints; the first `failedReads` reads of held states fail. */
function cloud(failedReads = 0) {
  const calls: CloudCall[] = []
  let states: { clientMessageId: string; state: string }[] = []
  let reads = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({
      url,
      method: init.method ?? 'GET',
      authorization: headers.get('authorization') ?? '',
      body
    })
    if (init.method === 'POST') {
      return Response.json({ status: 'held' })
    }
    return ++reads <= failedReads
      ? Response.json({ error: 'unavailable' }, { status: 503 })
      : Response.json({ v: 1, held: states })
  })
  return { calls, setStates: (next: typeof states) => (states = next) }
}

const send = (clientOperationId: string) =>
  structuredAgentSessionMessageSendMutation({
    sessionId: CHAT,
    clientOperationId,
    expectedRuntimeFence: null,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }
  })

beforeEach(() => {
  appStorage.clear()
  keychain.clear()
  vi.unstubAllGlobals()
})

describe('a page’s call to a shared agent', () => {
  heldIt(
    'holds a send with the share credential, sealed to the pinned host, and queues the next behind it',
    async () => {
      let now = 1_000
      const agents = new PhoneSharedAgents(() => now)
      const desktop = computer()
      const held = cloud()
      const page = routeSharedAgentCalls(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing reads only sendRequest and subscribe of the computer's client.
        desktop.client as unknown as RpcClient,
        'computer-1',
        agents
      )
      await agents.syncComputer('computer-1', desktop.client)

      const first = await page.sendRequest('agentSession.send', send('m1'), SHARED)
      expect(first.ok ? null : first.error.code).toBe(SHARED_BOT_HOST_ERRORS.held)
      expect(desktop.desktopCalls).toEqual([])
      const [hold] = held.calls
      const credential = hold?.authorization.replace('Bearer ', '') ?? ''
      expect(hold).toMatchObject({
        url: 'https://cloud.example/v1/shares/share-1/messages',
        method: 'POST'
      })
      expect(hashRelayCredential(credential)).toBe(desktop.asks[0]?.credentialHash)
      const opened = openBotTeamShareHeldMessage(PRIMITIVES, {
        hostSecretKey: HOST.secretKey,
        hostKey: HOST_KEY,
        sealed: ConnectorShareHoldRequestBody.parse(hold?.body).sealed,
        expect: { shareId: 'share-1', botId: 'bot-1', clientMessageId: 'm1' }
      })
      expect(opened?.devicePublicKey).toBe(desktop.asks[0]?.devicePublicKey)

      // Still waiting: the next send joins the queue behind it.
      held.setStates([{ clientMessageId: 'm1', state: 'waiting' }])
      await agents.refreshHeld()
      await page.sendRequest('agentSession.send', send('m2'), SHARED)
      expect(held.calls.filter((call) => call.method === 'POST')).toHaveLength(2)
      expect(held.calls.find((call) => call.method === 'GET')?.authorization).toBe(
        `Bearer ${credential}`
      )

      // Orca Cloud says the first landed; the second, never read again, reads Not sent past its wait.
      held.setStates([
        { clientMessageId: 'm1', state: 'delivered' },
        { clientMessageId: 'm2', state: 'waiting' }
      ])
      await agents.refreshHeld()
      now += HELD_WAIT_MS
      expect(agents.views('computer-1')[0]?.held.map((message) => message.state)).toEqual([
        'delivered',
        'not_sent'
      ])
    }
  )

  it('goes to the computer when it names no shared agent of this phone', async () => {
    const agents = new PhoneSharedAgents(() => 1_000)
    const desktop = computer()
    cloud()
    await agents.syncComputer('computer-1', desktop.client)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing reads only sendRequest and subscribe of the computer's client.
    const page = routeSharedAgentCalls(desktop.client as unknown as RpcClient, 'computer-1', agents)
    await page.sendRequest(
      'bots.chatTree',
      { botId: 'bot-1' },
      {
        envelope: { executionHost: 'runtime:a-paired-server' }
      }
    )
    expect(desktop.desktopCalls).toEqual(['bots.chatTree'])
    expect(
      namesPhoneSharedAgent(agents, 'computer-1', { executionHost: 'runtime:a-paired-server' })
    ).toBe(false)
    expect(namesPhoneSharedAgent(agents, 'computer-2', SHARED.envelope)).toBe(false)
  })

  heldIt(
    'keeps reading held states while one waits, backing off while Orca Cloud does not answer',
    async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const agents = new PhoneSharedAgents(() => 1_000)
        const desktop = computer()
        const held = cloud(1)
        const page = routeSharedAgentCalls(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing reads only sendRequest and subscribe of the computer's client.
          desktop.client as unknown as RpcClient,
          'computer-1',
          agents
        )
        await agents.syncComputer('computer-1', desktop.client)
        await page.sendRequest('agentSession.send', send('m1'), SHARED)
        const reads = () => held.calls.filter((call) => call.method === 'GET').length

        await vi.advanceTimersByTimeAsync(30_000)
        expect(reads()).toBe(1)
        held.setStates([{ clientMessageId: 'm1', state: 'delivered' }])
        // The failed read waits twice as long before the next.
        await vi.advanceTimersByTimeAsync(30_000)
        expect(reads()).toBe(1)
        await vi.advanceTimersByTimeAsync(30_000)
        expect(reads()).toBe(2)
        expect(agents.views('computer-1')[0]?.held.map((message) => message.state)).toEqual([
          'delivered'
        ])
        // Nothing waits, so nothing reads again.
        await vi.advanceTimersByTimeAsync(10 * 60_000)
        expect(reads()).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    }
  )
})

describe('a page frame before the phone’s shared agents are loaded', () => {
  it('waits for the computer’s verdict, and only a shared agent’s leaves once they load', async () => {
    const first = new PhoneSharedAgents(() => 1_000)
    cloud()
    await first.syncComputer('computer-1', computer().client)
    await vi.waitFor(() => expect(appStorage.size).toBe(1))

    // A cold launch: the kept agents are still being read when the page's frames arrive.
    const agents = new PhoneSharedAgents(() => 1_000)
    const frame = (id: string, executionHost: string): DesktopBound => ({
      v: 1,
      type: 'request',
      id,
      method: 'bots.chatTree',
      params: {},
      envelope: { executionHost }
    })
    const hold = createBridgeVerdictHold(
      () => null,
      () => {},
      (message) => namesPhoneSharedAgent(agents, 'computer-1', message.envelope)
    )
    expect(hold.admit(frame('shared', 'runtime:env-1'))).toBe(false)
    expect(hold.admit(frame('server', 'runtime:a-paired-server'))).toBe(false)

    await agents.ready()
    const sent: string[] = []
    hold.releaseBypassing((message) => sent.push(message.id))
    expect(sent).toEqual(['shared'])
    // The paired server's frame still waits for the computer's verdict.
    hold.releaseBypassing((message) => sent.push(message.id))
    expect(sent).toEqual(['shared'])
  })
})
