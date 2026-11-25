// A page's call naming a shared agent's host goes over the phone's own path, not the computer: while
// the host is away a send is sealed to the pinned host key and held with the phone's share credential,
// later sends in that chat queue behind it, and once Orca Cloud says it landed they go live again.
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

import { openBotTeamShareHeldMessage } from '../../../../src/shared/bots/bot-team-share-seal'
import {
  isSharedBotNewChatId,
  SHARED_BOT_HOST_ERRORS,
  SHARED_HOSTS_HOLD_WHILE_AWAY
} from '../../../../src/shared/bots/shared-bot-hosts'

// Held sends are off while SHARED_HOSTS_HOLD_WHILE_AWAY is: their tests run again when it is on.
const heldIt = it.skipIf(!SHARED_HOSTS_HOLD_WHILE_AWAY)
import { structuredAgentSessionMessageSendMutation } from '../../../../src/shared/agent-session/requests/structured-agent-session-send-mutation'
import { hashRelayCredential } from '../../../../src/shared/remote-runtime/relay/relay-credential-hash'
import { MOBILE_PAIRED_E2EE_PRIMITIVES as PRIMITIVES } from '../../transport/encryption/mobile-paired-e2ee-primitives'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { HELD_WAIT_MS, PhoneSharedAgentHeld } from './phone-shared-agent-held'
import { PhoneSharedAgentStore } from './phone-shared-agent-store'
import { sendMobileStructuredAgentSessionMessage } from '../../session/native-chat/agent-session/mobile-structured-agent-session-send'
import { scopeRpcClientToExecutionHost } from '../../worktree/execution-hosts/execution-host-scoped-rpc-client'
import { PhoneSharedAgents } from './phone-shared-agents'
import { namesPhoneSharedAgent, routeSharedAgentCalls } from './shared-agent-call-routing'
import { CHAT, cloud, computer, HOST, HOST_KEY, SHARED } from './phone-shared-agents.test-support'
import {
  createBridgeVerdictHold,
  type DesktopBound
} from '../../mobile-web-shell/host-bridge/bridge-host-verdict-hold'

const ConnectorShareHoldRequestBody = z.object({ sealed: z.string() })
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

describe('following a computer’s shares', () => {
  it('lists a share made after the phone connected, and two follows never ask for keys at once', async () => {
    const agents = new PhoneSharedAgents(() => 1_000)
    const desktop = computer()
    cloud()
    let shared = false
    let asking = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const client = {
      sendRequest: async (method: string, params?: unknown) => {
        if (method === 'sharedBots.phone.list' && !shared) {
          return { id: method, ok: true as const, result: { shares: [] } }
        }
        if (method === 'sharedBots.phone.provision') {
          asking++
          await gate
        }
        return await desktop.client.sendRequest(method, params)
      }
    }
    await agents.syncComputer('computer-1', client)
    expect(agents.views('computer-1')).toEqual([])

    shared = true
    const first = agents.syncComputer('computer-1', client)
    const second = agents.syncComputer('computer-1', client)
    await vi.waitFor(() => expect(asking).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(asking).toBe(1)
    release()
    await Promise.all([first, second])
    expect(agents.views('computer-1').map((view) => view.shareId)).toEqual(['share-1'])
  })
})

describe('a call to a shared agent whose owner stopped sharing it', () => {
  it('answers no longer shared, never offline, once the computer’s list read under way drops it', async () => {
    const agents = new PhoneSharedAgents(() => 1_000)
    const desktop = computer()
    cloud()
    let release: (() => void) | null = null
    let unshared = false
    const client = {
      sendRequest: async (method: string, params?: unknown) => {
        if (method === 'sharedBots.phone.list' && unshared) {
          await new Promise<void>((resolve) => (release = resolve))
          return { id: method, ok: true as const, result: { shares: [] } }
        }
        return await desktop.client.sendRequest(method, params)
      }
    }
    await agents.syncComputer('computer-1', client)
    const entry = agents.find('computer-1', 'env-1')!
    unshared = true
    const follow = agents.syncComputer('computer-1', client)
    await vi.waitFor(() => expect(release).not.toBeNull())
    const answer = agents.call(entry, 'bots.list', {})
    release!()
    await follow
    const response = await answer
    expect(response.ok ? null : response.error).toEqual({
      code: SHARED_BOT_HOST_ERRORS.unshared,
      message: 'This agent is no longer shared.'
    })
  })

  it('waits at most its cap for a computer that never answers, then reads as offline', async () => {
    const agents = new PhoneSharedAgents(() => 1_000)
    const desktop = computer()
    cloud()
    let away = false
    const client = {
      sendRequest: async (method: string, params?: unknown) =>
        method === 'sharedBots.phone.list' && away
          ? await new Promise<never>(() => {})
          : await desktop.client.sendRequest(method, params)
    }
    await agents.syncComputer('computer-1', client)
    const entry = agents.find('computer-1', 'env-1')!
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      away = true
      void agents.syncComputer('computer-1', client)
      const answer = agents.call(entry, 'bots.list', {})
      await vi.advanceTimersByTimeAsync(5_000)
      const response = await answer
      expect(response.ok ? null : response.error.code).toBe(SHARED_BOT_HOST_ERRORS.offline)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a send from the phone to a shared agent', () => {
  it('answers without Buffer: offline while holding is off (never parsed to hold), held when on', async () => {
    const agents = new PhoneSharedAgents(() => 1_000)
    cloud()
    await agents.syncComputer('computer-1', computer().client)
    const entry = agents.find('computer-1', 'env-1')!
    vi.stubGlobal('Buffer', undefined)
    const response = await agents.call(entry, 'agentSession.send', send('op-1'))
    expect(response.ok ? null : response.error.code).toBe(
      SHARED_HOSTS_HOLD_WHILE_AWAY ? SHARED_BOT_HOST_ERRORS.held : SHARED_BOT_HOST_ERRORS.offline
    )
  })

  it('answers as not sent, never rejecting, when the phone fails to take a call', async () => {
    const agents = new PhoneSharedAgents(() => 1_000)
    cloud()
    await agents.syncComputer('computer-1', computer().client)
    const entry = agents.find('computer-1', 'env-1')!
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stands in for any throw on the phone's path.
    vi.spyOn(agents as unknown as { reach: () => Promise<never> }, 'reach').mockRejectedValue(
      new ReferenceError('boom')
    )
    const response = await agents.call(entry, 'agentSession.send', send('op-2'))
    expect(response.ok ? null : response.error.code).toBe(SHARED_BOT_HOST_ERRORS.failed)
  })
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

describe('a new chat while the shared agent’s host is away', () => {
  it('with held sends off, starts no placeholder while the host is away and answers offline', async () => {
    const agents = new PhoneSharedAgents(() => 1_000)
    const desktop = computer()
    cloud()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing reads only sendRequest and subscribe of the computer's client.
    const page = routeSharedAgentCalls(desktop.client as unknown as RpcClient, 'computer-1', agents)
    await agents.syncComputer('computer-1', desktop.client)
    const started = await page.sendRequest('bots.session.start', { botId: 'bot-1' }, SHARED)
    expect(agents.views('computer-1')[0]?.holds).toBe(SHARED_HOSTS_HOLD_WHILE_AWAY)
    expect(started.ok ? null : started.error.code).toBe(SHARED_BOT_HOST_ERRORS.offline)
  })

  heldIt(
    'starts as a placeholder whose sends read as sent and wait, then moves to the chat its host starts',
    async () => {
      const agents = new PhoneSharedAgents(() => 1_000)
      const desktop = computer()
      cloud()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing reads only sendRequest and subscribe of the computer's client.
      const page = routeSharedAgentCalls(
        desktop.client as unknown as RpcClient,
        'computer-1',
        agents
      )
      await agents.syncComputer('computer-1', desktop.client)
      const shown: string[][] = []
      const stop = agents.watch('computer-1', (views) =>
        shown.push(views.flatMap((view) => view.held.map((held) => held.state)))
      )

      const started = await page.sendRequest('bots.session.start', { botId: 'bot-1' }, SHARED)
      const placeholder = started.ok
        ? z.object({ sessionId: z.string() }).parse(started.result).sessionId
        : ''
      expect(isSharedBotNewChatId(placeholder)).toBe(true)
      const errors: string[] = []
      const outcome = await sendMobileStructuredAgentSessionMessage({
        client: scopeRpcClientToExecutionHost(page, 'runtime:env-1'),
        sessionId: placeholder,
        // A shared agent's host takes no fence, as the chat sends while it is away.
        expectedRuntimeFence: null,
        text: 'Also check it on Android.',
        attachments: [],
        clientMessageId: 'm1',
        onError: (message) => errors.push(message)
      })
      expect({ outcome, errors }).toEqual({ outcome: 'accepted', errors: [] })
      expect(desktop.desktopCalls).toEqual([])
      const [view] = agents.views('computer-1')
      expect(view?.held).toMatchObject([{ sessionId: placeholder, state: 'waiting' }])
      // Drawn once with nothing held and once with it waiting; a change that alters nothing draws nothing.
      await agents.refreshHeld([])
      expect(shown).toEqual([[], ['waiting']])
      stop()

      // The host, back, starts the chat for the placeholder: its held message lands there.
      await vi.waitFor(() => expect([...appStorage.values()].join('')).toContain('m1'))
      const store = new PhoneSharedAgentStore()
      await store.load()
      const held = new PhoneSharedAgentHeld({ store, now: () => 1_000, changed: () => {} })
      held.noteAnswer(
        store.get('share-1')!,
        'bots.session.start',
        { botId: 'bot-1', newChatId: placeholder },
        { id: 'x', ok: true, result: { sessionId: 'chat-9' } }
      )
      expect(held.views(store.get('share-1')!).map((message) => message.sessionId)).toEqual([
        'chat-9'
      ])
    }
  )
})
