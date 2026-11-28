import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GOOGLE_OFFER_REPLAY_WINDOW_MS,
  MAX_GOOGLE_OFFER_ACTIONS
} from '../../../../shared/bots/bot-offer-answers'
import { BotController } from '../../../bots/bot-controller'
import { localBotHomeFilesystem } from '../../../bots/bot-home'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import {
  closeTestStores,
  createStore,
  readPersistedStateJson,
  testState
} from '../../../persistence/persistence-test-harness'
import type * as BotChatSession from '../../../bots/bot-chat-session'
import type { RpcContext } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { BOT_OFFER_ANSWER_METHOD } from './bots-offer-answer'
import { GOOGLE_METHODS } from './google'

type Send = { envelope: { sessionId: string }; body: { blocks: { text: string }[] } }

const { host, sends, chat } = vi.hoisted(() => {
  const sends: Send[] = []
  const chat = { beforeNext: async (): Promise<boolean> => true }
  const host = {
    deps: {
      store: {
        getConversation: (sessionId: string) => ({
          sessionId,
          provider: 'claude',
          location: { workspaceId: sessionId === 'foreign' ? 'folder:other' : 'folder:home-1' }
        }),
        requireWritableRecord: () => ({ lease: { runtimeFence: 1 } })
      }
    },
    send: async (_caller: unknown, input: Send) => {
      const admit = chat.beforeNext
      chat.beforeNext = async () => true
      if (!(await admit())) {
        return { ok: false, refusal: { code: 'agent_session_not_writable' } }
      }
      sends.push(input)
      return { ok: true, value: { clientMessageId: `m${sends.length}`, queued: {} } }
    },
    waitForSendSettlement: async () => undefined
  }
  return { host, sends, chat }
})

vi.mock('../../../google/google-connect', () => ({
  getGoogleConnect: () => ({
    accounts: async () => [
      { email: 'a@example.com' },
      { email: 'b@example.com' },
      { email: 'c@example.com' },
      { email: 'default@example.com' }
    ],
    defaultAccount: async () => 'default@example.com'
  })
}))

vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => host
}))

vi.mock('../../../bots/bot-chat-session', async (actual) => {
  const real = await actual<typeof BotChatSession>()
  return {
    ...real,
    runtimeBotChats: (runtime: { bots: BotChatSession.BotChatDependencies['bots'] }) =>
      real.botChatSessions({
        bots: runtime.bots,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a send to an open Chat reads only these.
        host: async () => host as unknown as BotChatSession.BotChatHost,
        createChat: async () => {},
        showTab: async () => {},
        closeChat: async () => ({ stopped: true }),
        dropUnreadMail: async () => {}
      })
  }
})

let store: ReturnType<typeof createStore>
let dispatcher: RpcDispatcher
let bots: BotController
const actionIds = new Map<string, string>()

beforeEach(async () => {
  sends.length = 0
  actionIds.clear()
  chat.beforeNext = async () => true
  testState.dir = await mkdtemp(join(tmpdir(), 'orca-bot-offer-'))
  store = createStore()
  store.saveBot(
    makeTestBot({
      id: 'b1',
      agent: 'claude',
      chatSessionId: 'chat-1',
      folderWorkspaceId: 'home-1',
      google: true,
      googleAccounts: ['a@example.com']
    })
  )
  await store.flushPendingOrThrowAsync()
  startHost()
})

function startHost(): void {
  bots = new BotController({
    getStore: () => store,
    notifyBotsWritten: () => {},
    createFolderWorkspace: async () => {
      throw new Error('The bot already has a home.')
    },
    deleteFolderWorkspace: async () => {},
    deleteBotAutomations: async () => {},
    botsRoot: () => testState.dir,
    slackIconsRoot: () => testState.dir,
    filesystem: localBotHomeFilesystem
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher and these methods only read these fields.
  const runtime = {
    bots,
    getRuntimeId: () => 'offer-test',
    ensureStructuredAgentSessionHost: async () => host
  } as unknown as RpcContext['runtime']
  dispatcher = new RpcDispatcher({
    runtime,
    methods: [
      BOT_OFFER_ANSWER_METHOD,
      ...GOOGLE_METHODS.filter((entry) =>
        ['google.bot.connected', 'google.bot.set'].includes(entry.name)
      )
    ]
  })
}

async function restartHost(): Promise<void> {
  await closeTestStores()
  store = createStore()
  startHost()
}

afterEach(async () => {
  vi.restoreAllMocks()
  await closeTestStores()
  await rm(testState.dir, { recursive: true, force: true })
})

const desktop = { caller: { kind: 'desktop' as const } }
const paired = {
  authenticatedCallerFingerprint: 'test-fingerprint',
  pairedDeviceId: 'test-device',
  clientKind: 'runtime' as const
}

async function request(
  method: string,
  params: unknown,
  client: typeof desktop | typeof paired = desktop
) {
  const response = await dispatcher.dispatch(
    { id: 'offer', authToken: 'test', method, params },
    client
  )
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result
}

function importItems(items: string[], sessionId: string | undefined = 'chat-1') {
  return request(
    'bots.offer.answer',
    {
      botId: 'b1',
      sessionId,
      text: `Import ${items}`,
      answer: { cardId: 'plan', sent: { chosen: items } }
    },
    paired
  )
}

function actionId(label: string): string {
  const prior = actionIds.get(label)
  if (prior) {
    return prior
  }
  const id = `${Date.now()}-${randomUUID()}`
  actionIds.set(label, id)
  return id
}

function googleAccount(account: string, action: string, sessionId?: string) {
  return request('google.bot.connected', {
    botId: 'b1',
    sessionId,
    account: `${account}@example.com`,
    card: { cardId: 'google', actionId: actionId(action) }
  })
}

function persistedBot() {
  const persisted: {
    bots: { offerAnswers?: { cardId: string }[]; googleAccounts?: string[] }[]
  } = JSON.parse(readPersistedStateJson())
  return persisted.bots[0]
}

function persistedCard(cardId: string): unknown {
  return persistedBot()?.offerAnswers?.find((entry) => entry.cardId === cardId)
}

const heardAccounts = () =>
  sends.map((send) => send.body.blocks[0]?.text.match(/account (\S+)/)?.[1])

describe('host-confirmed offer answers', () => {
  it('returns the recorded import after a lost confirmation without queuing a second turn', async () => {
    const lostReply = importItems(['1', '2']).then(() => {
      throw new Error('The connection closed before the reply.')
    })
    await expect(lostReply).rejects.toThrow('closed before the reply')
    await restartHost()
    const retry = await importItems(['1'])
    expect(sends.map((send) => send.body.blocks[0]?.text)).toEqual(['Import 1,2'])
    expect(retry).toMatchObject({ sent: true, answer: { sent: { chosen: ['1', '2'] } } })
    expect(persistedCard('plan')).toMatchObject({ sent: { chosen: ['1', '2'] } })
    await expect(importItems(['1'], 'foreign')).rejects.toThrow("isn't one of this bot's")
  })

  it.each([false, true])(
    'saves an admitted answer without resending after a save failure (committed: %s)',
    async (committed) => {
      const flush = store.flushPendingOrThrowAsync.bind(store)
      vi.spyOn(store, 'flushPendingOrThrowAsync').mockImplementationOnce(async (options) => {
        if (committed) {
          await flush(options)
        }
        throw new Error('Profile write unconfirmed')
      })
      await expect(importItems(['1', '2'])).rejects.toThrow('Profile write unconfirmed')
      expect(bots.list()[0]?.offerAnswers).toBeUndefined()
      expect(persistedCard('plan')).toEqual(
        committed ? { cardId: 'plan', sent: { chosen: ['1', '2'] } } : undefined
      )
      const edited = await bots.update('b1', { offerAnswer: { cardId: 'other', dismissed: true } })
      expect(edited.offerAnswers).toEqual([{ cardId: 'other', dismissed: true }])
      await expect(importItems(['2'])).resolves.toMatchObject({
        answer: { sent: { chosen: ['1', '2'] } }
      })
      expect(sends.map((send) => send.body.blocks[0]?.text)).toEqual(['Import 1,2'])
      expect(persistedCard('plan')).toMatchObject({ sent: { chosen: ['1', '2'] } })
    }
  )

  it('discards an admitted answer awaiting a save when the bot is deleted', async () => {
    vi.spyOn(store, 'flushPendingOrThrowAsync').mockRejectedValueOnce(
      new Error('Profile unavailable')
    )
    await expect(importItems(['1'])).rejects.toThrow('Profile unavailable')
    expect(bots.offerAnswerWrites.pending.size).toBe(1)
    await bots.delete({ botId: 'b1', deleteFolder: false })
    expect(bots.offerAnswerWrites.pending.size).toBe(0)
    expect(bots.list()).toEqual([])
  })

  it('keeps a newer Google choice across a competing refusal, a delayed sign-in, and a replay', async () => {
    await googleAccount('a', 'first')
    const signIn = Promise.withResolvers<void>()
    const delayedAnswer = signIn.promise.then(async () => {
      await request('google.bot.set', {
        botId: 'b1',
        on: true,
        accounts: ['a@example.com', 'c@example.com', 'b@example.com']
      })
      return googleAccount('b', 'late-sign-in')
    })
    await request('google.bot.set', {
      botId: 'b1',
      on: true,
      accounts: ['a@example.com', 'c@example.com']
    })
    const refused = Promise.withResolvers<boolean>()
    const started = Promise.withResolvers<void>()
    chat.beforeNext = () => {
      started.resolve()
      return refused.promise
    }
    const older = googleAccount('b', 'refused', 'chat-1')
    await started.promise
    const newer = googleAccount('c', 'newer', 'chat-1')
    refused.resolve(false)
    await expect(older).resolves.toEqual({ sent: false })
    await expect(newer).resolves.toMatchObject({ answer: { sent: { chosen: ['c@example.com'] } } })
    signIn.resolve()
    await expect(delayedAnswer).resolves.toMatchObject({
      answer: { sent: { chosen: ['b@example.com'] } }
    })
    await googleAccount('a', 'return-to-first')
    await restartHost()
    await expect(googleAccount('c', 'newer')).resolves.toMatchObject({
      answer: { sent: { chosen: ['a@example.com'] } }
    })
    expect(heardAccounts()).toEqual([
      'a@example.com',
      'c@example.com',
      'b@example.com',
      'a@example.com'
    ])
    expect(persistedCard('google')).toMatchObject({ sent: { chosen: ['a@example.com'] } })
    expect(persistedBot()?.googleAccounts).toEqual([
      'a@example.com',
      'c@example.com',
      'b@example.com'
    ])
  })

  it('remembers a default-account sign-in without pinning the account or announcing it', async () => {
    await googleAccount('default', 'default-sign-in')
    expect(persistedCard('google')).toMatchObject({
      cardId: 'google',
      googleActionIds: [actionId('default-sign-in')]
    })
    expect(persistedCard('google')).not.toHaveProperty('sent')
    await googleAccount('a', 'another-account')
    await googleAccount('default', 'default-sign-in', 'chat-1')
    expect(heardAccounts()).toEqual(['a@example.com'])
  })

  it('replays an action through the retention boundary and refuses it after expiry', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    await googleAccount('a', 'first')
    clock.mockReturnValue(now + GOOGLE_OFFER_REPLAY_WINDOW_MS)
    await expect(googleAccount('a', 'first')).resolves.toMatchObject({
      answer: { sent: { chosen: ['a@example.com'] } }
    })

    clock.mockReturnValue(now + GOOGLE_OFFER_REPLAY_WINDOW_MS + 1)
    await expect(googleAccount('a', 'first')).rejects.toThrow('card answer expired')
    await googleAccount('b', 'newly-signed-in')
    clock.mockReturnValue(now + GOOGLE_OFFER_REPLAY_WINDOW_MS)
    await expect(googleAccount('a', 'first')).rejects.toThrow('card answer expired')
    expect(heardAccounts()).toEqual(['a@example.com', 'b@example.com'])
    expect(persistedCard('google')).toMatchObject({
      googleActionIds: [actionId('newly-signed-in')]
    })
  })

  it('keeps every unexpired receipt when the card reaches its limit', async () => {
    const ids = Array.from({ length: MAX_GOOGLE_OFFER_ACTIONS }, (_, index) =>
      actionId(`existing-${index}`)
    )
    await bots.update('b1', {
      offerAnswerConfirmation: {
        cardId: 'google',
        answers: [{ cardId: 'google', sent: { chosen: ['a@example.com'] }, googleActionIds: ids }]
      }
    })
    await expect(googleAccount('b', 'over-limit')).rejects.toThrow('too many recent Google answers')
    await expect(googleAccount('a', 'existing-0')).resolves.toMatchObject({
      answer: { sent: { chosen: ['a@example.com'] } }
    })
    expect(sends).toEqual([])
    expect(persistedCard('google')).toMatchObject({ googleActionIds: ids })
  })

  it('retains an older stored choice without replay receipts through a reopen', async () => {
    await bots.update('b1', {
      offerAnswerConfirmation: {
        cardId: 'google',
        answers: [{ cardId: 'google', sent: { chosen: ['a@example.com'] } }]
      }
    })
    await restartHost()
    expect(bots.list()[0]?.offerAnswers).toMatchObject([{ sent: { chosen: ['a@example.com'] } }])
    await googleAccount('b', 'new-action-on-older-card')
    expect(heardAccounts()).toEqual(['b@example.com'])
  })
})
