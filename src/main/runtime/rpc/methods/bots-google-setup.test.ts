import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { getBrowserHostRequestRegistry } from '../../browser-host/leases/browser-host-request-registry'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { Bot } from '../../../../shared/bot-types'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { BOT_GROUP_ROOM_CARD_REFUSAL } from '../../../bots/bot-group-session-access'
import { GoogleSetupRuns } from '../../../google/google-setup-runs'
import { registerGoogleCardRenderer } from '../../../google/google-card-reach'
import { DESKTOP_RPC_CALLER, LOCAL_CLI_RPC_CALLER } from '../callers/rpc-caller-identity'

const dir = mkdtempSync(join(tmpdir(), 'orca-google-setup-rpc-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const sent = vi.hoisted((): unknown[][] => [])
const cards = vi.hoisted((): unknown[][] => [])
vi.mock('../../../bots/bot-chat-status-line', () => ({
  writeInChat: (sessionId: string | undefined, body: { googleSetup?: { card: string } }) =>
    cards.push([sessionId, body.googleSetup?.card])
}))
const store = vi.hoisted((): { runs: GoogleSetupRuns | null } => ({ runs: null }))
vi.mock('../../../bots/bot-session-tabs', () => ({
  botOfSession: (bots: { list: () => Bot[] }, sessionId: string) =>
    ['ivy-chat', 'bot-group-member-m1'].includes(sessionId) ? bots.list()[0] : null
}))
vi.mock('../../../bots/tool-relay/bot-tool-relay', () => ({
  botToolRelay: { botOf: (token: string) => (token === 'ivy-token' ? 'ivy' : null) }
}))
vi.mock('../../../bots/bot-chat-session', () => ({
  runtimeBotChats: () => ({
    sendToChat: async (...args: unknown[]) => {
      sent.push(args)
      return { sessionId: 'ivy-chat' }
    }
  })
}))
type FakeGoogle = {
  client: { clientId: string; projectId?: string } | null
  accounts: { email: string; status: string; connectedAt: number; services: unknown[] }[]
  clientKey: 'works' | 'gone' | null
  installed: boolean
  turnRunning: boolean
}
const google = vi.hoisted((): FakeGoogle => ({
  client: null,
  accounts: [],
  clientKey: null,
  installed: true,
  turnRunning: false
}))
vi.mock('../../../google/google-connect', () => ({
  getGoogleConnect: () =>
    google.installed
      ? {
          client: () => google.client,
          accounts: () => google.accounts,
          checkAccounts: async () => google.accounts,
          checkClient: async () => google.clientKey,
          clientCheck: () => google.clientKey
        }
      : null
}))
const offers = vi.hoisted((): [string, { connectorOffer?: unknown }][] => [])
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    captureAgentStartDestination: async (sessionId: string) => ({ sessionId }),
    appendAgentStart: async (
      destination: { sessionId: string },
      entry: { body: { connectorOffer?: unknown } }
    ) => {
      offers.push([destination.sessionId, entry.body])
    }
  })
}))
vi.mock('../../../bots/bot-automation-sessions', () => ({
  botTurns: { running: () => google.turnRunning }
}))
vi.mock('../../../google/google-setup-runs', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  googleSetupRuns: () => store.runs
}))

const { GOOGLE_SETUP_METHODS } = await import('./bots-google-setup')

const request = (method: string, params: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method,
  params
})

let dispatcher: RpcDispatcher
let bot: Bot
let headless = false
let service: OrcaRuntimeService
beforeEach(() => {
  headless = false
  offers.length = 0
  google.client = null
  google.accounts = []
  google.clientKey = null
  google.installed = true
  google.turnRunning = false
  sent.length = 0
  cards.length = 0
  store.runs = new GoogleSetupRuns(() => join(dir, `${Math.random()}.json`))
  bot = makeTestBot({ id: 'ivy', name: 'Ivy', chatSessionId: 'ivy-chat' })
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    servesWithoutWindow: () => headless,
    bots: { assertEnabled: () => {}, enabled: () => true, list: () => [bot] },
    lookAround: { botOfLook: () => null, botOfTidyUp: () => null }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods read only runtime.bots, runtime.lookAround, servesWithoutWindow and the runtime id, which the stub provides.
  service = runtime as unknown as OrcaRuntimeService
  dispatcher = new RpcDispatcher({ runtime: service, methods: GOOGLE_SETUP_METHODS })
})

describe('bots.googleSetup', () => {
  it('lets a bot move its own run from its chat', async () => {
    const started = await dispatcher.dispatch(
      request('bots.googleSetup.write', {
        botToken: 'ivy-token',
        callerSessionId: 'ivy-chat',
        change: { action: 'start', mode: 'guide-here' }
      })
    )
    expect(started).toMatchObject({
      ok: true,
      result: { run: { botId: 'ivy', mode: 'guide-here' } }
    })
    expect(offers).toEqual([])
    expect(
      await dispatcher.dispatch(
        request('bots.googleSetup.read', { botToken: 'ivy-token', callerSessionId: 'ivy-chat' })
      )
    ).toMatchObject({ ok: true, result: { run: { botId: 'ivy' } } })
  })

  it('records owner card answers and wakes the bot, without a bubble, once services are chosen', async () => {
    await dispatcher.dispatch(
      request('bots.googleSetup.write', {
        botToken: 'ivy-token',
        callerSessionId: 'ivy-chat',
        change: { action: 'start' }
      })
    )
    await dispatcher.dispatch(
      request('bots.googleSetup.answer', { botId: 'ivy', card: 'path', values: ['do-it-for-me'] }),
      { caller: DESKTOP_RPC_CALLER, clientKind: 'runtime' }
    )
    // The path brings the services card; the bot waits for it rather than opening Google Cloud.
    expect(cards).toEqual([
      ['ivy-chat', 'path'],
      ['ivy-chat', 'services']
    ])
    expect(sent).toEqual([])
    const answered = await dispatcher.dispatch(
      request('bots.googleSetup.answer', {
        botId: 'ivy',
        card: 'services',
        values: ['gmail', 'calendar']
      }),
      { caller: DESKTOP_RPC_CALLER, clientKind: 'runtime' }
    )
    expect(answered).toMatchObject({
      ok: true,
      result: { run: { services: ['gmail', 'calendar'] } }
    })
    expect(sent).toEqual([
      ['ivy', 'Card google-setup/services answered: gmail, calendar', 'card-answer']
    ])
  })

  it('never takes a card answer, or a lock-lifting change, from a CLI', async () => {
    await dispatcher.dispatch(
      request('bots.googleSetup.write', {
        botToken: 'ivy-token',
        callerSessionId: 'ivy-chat',
        change: { action: 'start', mode: 'guide-here' }
      })
    )
    expect(
      await dispatcher.dispatch(
        request('bots.googleSetup.answer', { botId: 'ivy', card: 'step', values: ['take-over'] }),
        { caller: LOCAL_CLI_RPC_CALLER }
      )
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining('Only your owner') } })
    // An agent that leaves its chat id off still counts as a bot.
    expect(
      await dispatcher.dispatch(
        request('bots.googleSetup.write', {
          botId: 'ivy',
          change: { action: 'answer', card: 'path', values: ['do-it-for-me'] }
        }),
        { caller: LOCAL_CLI_RPC_CALLER }
      )
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining('hand the clicking') } })
    expect(sent).toEqual([])
  })

  it("starts a setup for the owner in the bot's chat, with its first card and no bubble", async () => {
    const owner = { caller: DESKTOP_RPC_CALLER, clientKind: 'runtime' as const }
    const started = await dispatcher.dispatch(
      request('bots.googleSetup.start', { botId: 'ivy', from: 'settings' }),
      owner
    )
    // The person clicks until the owner picks a path.
    expect(started).toMatchObject({
      ok: true,
      result: { run: { state: 'running', mode: 'unchosen' } }
    })
    expect(sent).toEqual([['ivy', expect.stringContaining('from settings'), 'card-answer']])
    expect(cards).toEqual([['ivy-chat', 'path']])
    // Pressed again, it goes back to the same setup.
    const again = await dispatcher.dispatch(
      request('bots.googleSetup.start', { botId: 'ivy', from: 'add-connector' }),
      owner
    )
    expect(again).toMatchObject({ ok: true, result: { run: { id: store.runs?.get('ivy')?.id } } })
    expect(sent).toHaveLength(1)
    expect(cards).toHaveLength(1)
  })

  it('never starts a setup for a CLI', async () => {
    expect(
      await dispatcher.dispatch(
        request('bots.googleSetup.start', { botId: 'ivy', from: 'settings' }),
        { caller: LOCAL_CLI_RPC_CALLER }
      )
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining('Only your owner') } })
    expect(store.runs?.get('ivy')).toBeNull()
  })

  it('keeps the client step open and writes one recovery card until the matching key arrives', async () => {
    const bot = (change: Record<string, unknown>) =>
      dispatcher.dispatch(
        request('bots.googleSetup.write', {
          botToken: 'ivy-token',
          callerSessionId: 'ivy-chat',
          change
        })
      )
    const read = () =>
      dispatcher.dispatch(
        request('bots.googleSetup.read', { botToken: 'ivy-token', callerSessionId: 'ivy-chat' })
      )
    await bot({ action: 'start' })
    store.runs?.apply('ivy', 'owner', { action: 'answer', card: 'path', values: ['do-it-for-me'] })
    await bot({ action: 'set', projectId: 'example-project-123' })
    expect(await read()).toMatchObject({ ok: true, result: { keyMissing: false } })
    await bot({ action: 'step', step: 'client', status: 'active' })
    // Still making the key: no owner buttons yet.
    expect(await read()).toMatchObject({ ok: true, result: { keyMissing: true, blocker: null } })
    cards.length = 0
    expect(await bot({ action: 'step', step: 'client', status: 'done' })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Make a new key · Import a key file') }
    })
    // The refusal leaves the owner's card with the recovery the bot just named.
    expect(await read()).toMatchObject({
      ok: true,
      result: {
        keyMissing: true,
        blocker: { kind: 'no-key', actions: [{ id: 'make-new-key' }, { id: 'import-key' }] }
      }
    })
    expect(await bot({ action: 'step', step: 'client', status: 'done' })).toMatchObject({
      ok: false
    })
    expect(cards).toEqual([['ivy-chat', 'progress']])

    // A key from another project isn't this setup's.
    google.client = { clientId: 'x.apps.googleusercontent.com', projectId: 'old-project' }
    expect(await bot({ action: 'step', step: 'client', status: 'done' })).toMatchObject({
      ok: false
    })
    expect(cards).toEqual([['ivy-chat', 'progress']])

    google.client = { clientId: 'x.apps.googleusercontent.com', projectId: 'example-project-123' }
    expect(await read()).toMatchObject({ ok: true, result: { keyMissing: false } })
    expect(await bot({ action: 'step', step: 'client', status: 'done' })).toMatchObject({
      ok: true,
      result: { run: { steps: { client: { status: 'done' } } } }
    })
  })

  it('writes the sign-in card again at the bottom when done is refused for want of it, once', async () => {
    const bot = (change: Record<string, unknown>) =>
      dispatcher.dispatch(
        request('bots.googleSetup.write', {
          botToken: 'ivy-token',
          callerSessionId: 'ivy-chat',
          change
        })
      )
    await bot({ action: 'start' })
    store.runs?.apply('ivy', 'owner', { action: 'answer', card: 'path', values: ['do-it-for-me'] })
    google.client = { clientId: 'x.apps.googleusercontent.com' }
    store.runs?.apply('ivy', 'owner', {
      action: 'answer',
      card: 'step',
      values: ['done', 'client']
    })
    cards.length = 0
    expect(await bot({ action: 'done' })).toMatchObject({ ok: false })
    expect(await bot({ action: 'done' })).toMatchObject({ ok: false })
    expect(cards).toEqual([['ivy-chat', 'connect']])
  })

  it("refuses the bot's done until every chosen service is ready, naming the owner's buttons", async () => {
    const bot = (change: Record<string, unknown>) =>
      dispatcher.dispatch(
        request('bots.googleSetup.write', {
          botToken: 'ivy-token',
          callerSessionId: 'ivy-chat',
          change
        })
      )
    await bot({ action: 'start' })
    store.runs?.apply('ivy', 'owner', { action: 'answer', card: 'path', values: ['do-it-for-me'] })
    await bot({ action: 'set', account: 'you@gmail.com', kind: 'work', services: ['gmail'] })
    for (const step of ['account', 'project', 'apis']) {
      await bot({ action: 'step', step, status: 'done' })
    }
    await bot({ action: 'step', step: 'links', status: 'skipped' })
    await bot({ action: 'step', step: 'publish', status: 'skipped' })
    // Client as Orca finishes it when the key arrives; the key is gone again by the end.
    for (const step of ['branding', 'client', 'connect']) {
      store.runs?.apply('ivy', 'owner', { action: 'answer', card: 'step', values: ['done', step] })
    }
    // No key saved: the card offers a new key, and the bot hears the same words.
    expect(await bot({ action: 'done' })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Make a new key · Import a key file') }
    })
    google.client = { clientId: 'x.apps.googleusercontent.com' }
    const services = (state: string) => ['gmail', 'calendar'].map((service) => ({ service, state }))
    google.accounts = [
      {
        email: 'you@gmail.com',
        status: 'connected',
        connectedAt: 5,
        services: services('needs-permission')
      }
    ]
    expect(await bot({ action: 'done' })).toMatchObject({
      ok: false,
      // Gmail is the only service chosen, so there's nothing to go on without.
      error: { message: expect.stringContaining("Your owner's card shows: Allow Gmail.") }
    })
    expect(
      await dispatcher.dispatch(
        request('bots.googleSetup.read', { botToken: 'ivy-token', callerSessionId: 'ivy-chat' })
      )
    ).toMatchObject({ ok: true, result: { blocker: { kind: 'needs-permission' } } })
    google.accounts = [
      { email: 'you@gmail.com', status: 'connected', connectedAt: 5, services: services('ready') }
    ]
    // A key Google removed stops it; one Google couldn't be asked about doesn't.
    google.clientKey = 'gone'
    expect(await bot({ action: 'done' })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Make a new key · Start over') }
    })
    google.clientKey = null
    expect(await bot({ action: 'done' })).toMatchObject({
      ok: true,
      result: { run: { state: 'done' }, blocker: null }
    })
  })
})

describe("a bot's Google setup start when Google's app is already here", () => {
  const signedIn = { email: 'owner@acme.dev', connectedAt: 1, services: [] }
  const start = (callerSessionId = 'ivy-chat') =>
    dispatcher.dispatch(
      request('bots.googleSetup.write', {
        botToken: 'ivy-token',
        callerSessionId,
        change: { action: 'start' }
      })
    )
  const offered = () => offers.map(([sessionId, body]) => [sessionId, body.connectorOffer])

  it('shows the Connect card instead of the setup when an account is signed in and Google is off', async () => {
    google.client = { clientId: 'c1' }
    google.accounts = [{ ...signedIn, status: 'connected' }]
    expect(await start()).toMatchObject({ ok: true, result: { routed: 'offer' } })
    expect(offered()).toEqual([['ivy-chat', { botId: 'ivy', source: 'google' }]])
    expect(store.runs?.get('ivy')).toBeNull()
  })

  it('refuses the Connect card from a group room, which shows no card, and writes none', async () => {
    google.client = { clientId: 'c1' }
    google.accounts = [{ ...signedIn, status: 'connected' }]
    expect(await start('bot-group-member-m1')).toMatchObject({
      ok: false,
      error: { message: BOT_GROUP_ROOM_CARD_REFUSAL }
    })
    expect(offered()).toEqual([])
    expect(store.runs?.get('ivy')).toBeNull()
  })

  it('says Google is already on, with no card and no run, once it is on and signed in', async () => {
    bot.google = true
    google.client = { clientId: 'c1' }
    google.accounts = [{ ...signedIn, status: 'connected' }]
    for (const callerSessionId of ['ivy-chat', 'bot-group-member-m1']) {
      expect(await start(callerSessionId)).toMatchObject({ ok: true, result: { routed: 'on' } })
    }
    expect(offers).toEqual([])
    expect(store.runs?.get('ivy')).toBeNull()
  })

  it('offers the card when a bot has Google on and the account needs to reconnect', async () => {
    bot.google = true
    google.client = { clientId: 'c1' }
    google.accounts = [{ ...signedIn, status: 'reconnect' }]
    expect(await start()).toMatchObject({ ok: true, result: { routed: 'offer' } })
    expect(offered()).toEqual([['ivy-chat', { botId: 'ivy', source: 'google' }]])
  })

  it('resumes a running setup rather than routing it, so a retry after sign-in keeps its checks', async () => {
    await start()
    const running = store.runs?.get('ivy')
    google.client = { clientId: 'c1' }
    google.accounts = [{ ...signedIn, status: 'connected' }]
    expect(await start()).toMatchObject({ ok: true, result: { run: { id: running?.id } } })
    expect(offers).toEqual([])
  })

  it('on a server with no owner window, posts no card', async () => {
    headless = true
    google.client = { clientId: 'c1' }
    google.accounts = [{ ...signedIn, status: 'connected' }]
    expect(await start()).toMatchObject({ ok: true, result: { routed: 'server' } })
    expect(offers).toEqual([])
  })

  it('on a server with a paired desktop that can open the sign-in page and draws the card, posts it', async () => {
    headless = true
    getBrowserHostRequestRegistry(service).register({ pairedDeviceId: 'desk', emit: () => {} })
    const unregister = registerGoogleCardRenderer()
    try {
      google.client = { clientId: 'c1' }
      google.accounts = [{ ...signedIn, status: 'reconnect' }]
      expect(await start()).toMatchObject({ ok: true, result: { routed: 'offer' } })
      expect(offered()).toEqual([['ivy-chat', { botId: 'ivy', source: 'google' }]])
    } finally {
      unregister()
    }
  })

  it('on a server whose paired desktop can open the page but not draw the card, posts none', async () => {
    headless = true
    getBrowserHostRequestRegistry(service).register({ pairedDeviceId: 'desk', emit: () => {} })
    google.client = { clientId: 'c1' }
    google.accounts = [{ ...signedIn, status: 'reconnect' }]
    await start()
    expect(offered()).toEqual([])
  })
})
