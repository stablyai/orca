import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { hostname } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { BOTS_DISABLED_CODE, BotsDisabledError } from '../../../../shared/bots-switch'
import { RpcDispatcher } from '../dispatcher'
import { DESKTOP_RPC_CALLER, LOCAL_CLI_RPC_CALLER } from '../callers/rpc-caller-identity'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { Bot } from '../../../../shared/bot-types'
import { applyBotUpdates, type BotUpdateParams } from '../../../../shared/rpc-contract/bots-params'
import { BOT_METHODS } from './bots'
import { BOT_ACCESS_METHODS } from './bots-access'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { fakeAccessCloud } from '../../../bots/bot-access-cloud.test-fixture'
import { makeAccessRequest } from '../../../../shared/bots/bot-access-request.test-fixture'

const started = vi.hoisted((): { bots: unknown[] } => ({ bots: [] }))
const chats = vi.hoisted(() => {
  return {
    reset: vi.fn(async (_botId: string) => 'home-2'),
    send: vi.fn(async (_botId: string, _text: string, _origin?: string) => {}),
    // The bot whose home each session lives in.
    homes: new Map<string, string>()
  }
})
vi.mock('../../../bots/bot-chat-session', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startBotSession: vi.fn(async (_runtime: unknown, bot: unknown) => {
    started.bots.push(bot)
    return 'session-1'
  }),
  runtimeBotChats: () => ({ reset: chats.reset, sendToChat: chats.send }),
  requireStructuredHost: async () => ({
    journalReads: async () => {
      const items = [{ itemId: 'm1', body: { blocks: [], kind: 'message', role: 'user' } }]
      return {
        promptItem: async () => items[0],
        operationWindow: async () => ({ complete: true, snapshot: { items, submissions: [] } })
      }
    }
  })
}))
const shared = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../../../bots/sharing/bot-share-create', () => ({ createBotFromShare: shared.create }))
vi.mock('./bots-share-create-deps', () => ({ botShareCreateDeps: () => ({}) }))
const releaseHeldBotMail = vi.hoisted(() => vi.fn())
vi.mock('../../../bots/bot-paused-mail', () => ({ releaseHeldBotMail }))
vi.mock('../../../bots/bot-session-tabs', () => ({
  botOfSession: (bots: { list: () => Bot[] }, sessionId: string) =>
    bots.list().find((bot) => bot.id === chats.homes.get(sessionId)) ?? null
}))
// The bot delete signs out the bot's tools under the real agent home; a refusal must stop first.
const forgetDeletedBotTools = vi.hoisted(() => vi.fn())
vi.mock('./bots-tools', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  forgetDeletedBotTools
}))

function request(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('bots RPC methods with bots turned off', () => {
  it('refuses to create a bot or open its Chat for every client, and still lists bots', async () => {
    const bots = {
      assertEnabled: () => {
        throw new BotsDisabledError()
      },
      create: vi.fn(),
      listing: vi.fn(() => ({ bots: [], botsEnabled: false, hideBotCreatedWorkspaces: true }))
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods read only runtime.bots, its webhooks, its connector cloud, whether it has a window and the runtime id, which the stub provides.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getWebhooks: () => null,
      getUIState: () => ({}),
      getConnectorCloud: () => null,
      servesWithoutWindow: () => false,
      bots
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BOT_METHODS })
    const refused = { ok: false, error: { code: BOTS_DISABLED_CODE } }

    expect(await dispatcher.dispatch(request('bots.create', { name: 'Reviewer' }))).toMatchObject(
      refused
    )
    expect(await dispatcher.dispatch(request('bots.chat.open', { botId: 'b1' }))).toMatchObject(
      refused
    )
    expect(await dispatcher.dispatch(request('bots.session.start', { botId: 'b1' }))).toMatchObject(
      refused
    )
    expect(bots.create).not.toHaveBeenCalled()
    expect(await dispatcher.dispatch(request('bots.list'))).toMatchObject({
      ok: true,
      // Clients draw a host with bots off as the host's own sidebar does: no Bots section.
      result: { bots: [], botsEnabled: false, threadReplies: false }
    })
  })
})

describe('bots.create', () => {
  const OWNER = { caller: DESKTOP_RPC_CALLER }

  function createRuntime(proposer: Bot | null = null) {
    const order: string[] = []
    const made = makeTestBot({ id: 'cutter', name: 'Cutter' })
    let saved = proposer
    const bots = {
      assertEnabled: () => {},
      list: () => (saved ? [saved] : []),
      create: vi.fn(async () => {
        order.push('created with its soul')
        return made
      }),
      createFromOffer: vi.fn(async ({ fromOffer }: { fromOffer: { offerId: string } }) => {
        const accepted = saved?.acceptedOffers?.some((entry) => entry.offerId === fromOffer.offerId)
        if (accepted) {
          return { bot: made, existing: true }
        }
        saved = { ...saved!, acceptedOffers: [{ offerId: fromOffer.offerId, botId: made.id }] }
        return { bot: made, existing: false }
      })
    }
    chats.send.mockImplementationOnce(async () => {
      order.push('first turn')
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bots.create reads only runtime.bots and the bot chats, which the stub and mock provide.
    const runtime = { getRuntimeId: () => 'test-runtime', bots } as unknown as OrcaRuntimeService
    return {
      bots,
      order,
      proposer: () => saved,
      dispatcher: new RpcDispatcher({ runtime, methods: BOT_METHODS })
    }
  }

  it("defers the first turn for a takeover and runs it after writing a proposed bot's soul", async () => {
    const { bots, order, dispatcher } = createRuntime()
    const seed = { purpose: 'Tracks what’s blocking the 1.5 release.', templateId: 'release' }

    chats.send.mockClear()
    expect(
      await dispatcher.dispatch(request('bots.create', { name: '  ', takingOver: true }), OWNER)
    ).toMatchObject({ ok: true, result: { bot: { id: 'cutter' } } })
    expect(bots.create).toHaveBeenCalledExactlyOnceWith({ name: '' })
    expect(chats.send).not.toHaveBeenCalled()
    order.length = 0

    expect(
      await dispatcher.dispatch(
        request('bots.create', {
          name: 'Cutter',
          seed,
          handOff: [{ id: 'w1', name: 'release-checklist' }]
        }),
        OWNER
      )
    ).toMatchObject({ ok: true, result: { bot: { id: 'cutter' } } })
    expect(bots.create).toHaveBeenCalledWith({ name: 'Cutter', seed })
    expect(chats.send).toHaveBeenCalledWith(
      'cutter',
      expect.stringContaining(
        'Your owner made you for these workspaces: release-checklist (id:w1).'
      ),
      'bot-created'
    )
    expect(order).toEqual(['created with its soul', 'first turn'])
  })

  it("greets from a shared link: its first turn names the link's sharer", async () => {
    const { dispatcher } = createRuntime()
    const sharedFrom = {
      shareId: 's1',
      packageId: 'p1',
      versionId: 'v1',
      sharedBy: 'Dara',
      sharedAt: '2026-11-09T00:00:00Z'
    }
    shared.create.mockResolvedValueOnce(makeTestBot({ id: 'notes', name: 'Notes', sharedFrom }))
    const fromShare = { reviewId: '6f1c2b1e-9a35-4d3a-8a52-0d8f3c1b2a10', toolIds: [] }

    expect(
      await dispatcher.dispatch(request('bots.create', { name: 'Notes', fromShare }), OWNER)
    ).toMatchObject({ ok: true, result: { bot: { id: 'notes' } } })
    expect(chats.send).toHaveBeenCalledWith(
      'notes',
      expect.stringContaining('You came from "Dara"\'s shared link.'),
      'bot-created'
    )
  })

  it("refuses an agent's CLI: a bot proposes a bot and only its owner creates one", async () => {
    const { bots, dispatcher } = createRuntime()
    expect(
      await dispatcher.dispatch(request('bots.create', { name: 'Cutter' }), {
        caller: LOCAL_CLI_RPC_CALLER
      })
    ).toMatchObject({ ok: false })
    expect(bots.create).not.toHaveBeenCalled()
  })

  it('returns the original bot when a second acceptance includes an unknown template', async () => {
    const { bots, proposer, dispatcher } = createRuntime(
      makeTestBot({ id: 'atlas', name: 'Atlas' })
    )
    const fromOffer = { botId: 'atlas', offerId: 'offer-1' }
    const handOff = [{ id: 'w1', name: 'release-checklist' }]

    expect(
      await dispatcher.dispatch(
        request('bots.create', { name: 'Release', fromOffer, handOff }),
        OWNER
      )
    ).toMatchObject({ ok: true, result: { bot: { id: 'cutter' } } })
    expect(proposer()?.acceptedOffers).toEqual([{ offerId: 'offer-1', botId: 'cutter' }])
    chats.send.mockClear()
    expect(
      await dispatcher.dispatch(
        request('bots.create', {
          name: 'Cutter',
          fromOffer,
          handOff,
          fromTemplate: { id: 'from-a-newer-build', skills: [] }
        }),
        OWNER
      )
    ).toMatchObject({ ok: true, result: { bot: { id: 'cutter' } } })
    expect(bots.createFromOffer).toHaveBeenLastCalledWith(
      { name: 'Cutter', fromOffer },
      undefined,
      expect.any(Function)
    )
    expect(chats.send).not.toHaveBeenCalled()
    expect(bots.create).not.toHaveBeenCalled()
  })
})

describe('bots.list', () => {
  it("carries each bot's waits still waiting, for its sidebar row", async () => {
    const bot = makeTestBot()
    const wait = { id: 'w1', name: "Nora's reply", once: { by: 5000 }, bot: { botId: bot.id } }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bots.list reads only runtime.bots, its webhooks, its connector cloud, whether it has a window, its automations and its item counts, which the stub provides.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getWebhooks: () => null,
      getUIState: () => ({}),
      getConnectorCloud: () => null,
      servesWithoutWindow: () => false,
      bots: {
        listing: () => ({ bots: [bot], botsEnabled: true, hideBotCreatedWorkspaces: true })
      },
      listAutomationsForScope: () => ({ automations: [wait] }),
      listAutomationRunsByAutomation: () => new Map(),
      botItems: { needsYouCounts: async () => ({ counts: {}, at: 0 }) }
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BOT_METHODS })

    expect(await dispatcher.dispatch(request('bots.list'))).toMatchObject({
      ok: true,
      result: { waits: { [bot.id]: [{ label: "Nora's reply", by: 5000 }] } }
    })
  })

  it.each<[boolean, string | null]>([
    [true, hostname().slice(0, 256)],
    [false, null]
  ])(
    'names a headless server for its signed-out copy, and says null with a window (headless %s)',
    async (headless, signInServer) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bots.list reads only runtime.bots, its webhooks, its connector cloud, whether it has a window and its UI state, which the stub provides.
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        getWebhooks: () => null,
        getUIState: () => ({}),
        getConnectorCloud: () => null,
        servesWithoutWindow: () => headless,
        bots: { listing: () => ({ bots: [], botsEnabled: true, hideBotCreatedWorkspaces: true }) }
      } as unknown as OrcaRuntimeService
      const answer = await new RpcDispatcher({ runtime, methods: BOT_METHODS }).dispatch(
        request('bots.list')
      )
      expect(answer).toMatchObject({ ok: true })
      expect(answer).toHaveProperty('result.signInServer', signInServer)
    }
  )
})

describe('bots.session.start', () => {
  it('refuses a bot that does not exist', async () => {
    const bots = { assertEnabled: () => {}, list: vi.fn(() => []) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refusal reads only runtime.bots, its webhooks and the runtime id, which the stub provides.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getWebhooks: () => null,
      bots
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BOT_METHODS })

    expect(
      await dispatcher.dispatch(request('bots.session.start', { botId: 'missing' }))
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining('bot_not_found') } })
  })

  it("starts on the agent asked for, and on the bot's own agent otherwise", async () => {
    const bot = { id: 'b1', agent: 'claude' } satisfies Pick<Bot, 'id' | 'agent'>
    const bots = { assertEnabled: () => {}, list: vi.fn(() => [bot]) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only runtime.bots, its webhooks and the runtime id; the session start is mocked.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getWebhooks: () => null,
      bots
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BOT_METHODS })
    started.bots.length = 0

    await dispatcher.dispatch(request('bots.session.start', { botId: 'b1', agent: 'codex' }))
    await dispatcher.dispatch(request('bots.session.start', { botId: 'b1' }))

    expect(started.bots).toEqual([
      { id: 'b1', agent: 'codex' },
      { id: 'b1', agent: 'claude' }
    ])
    expect(
      await dispatcher.dispatch(request('bots.session.start', { botId: 'b1', agent: 'aider' }))
    ).toMatchObject({ ok: false })
  })
})

describe('bots.update from a phone', () => {
  const dana = { id: 'U1', name: 'Dana', source: 'slack' }
  const lin = { id: 'U1', name: 'Lin', source: 'linear', workspaceId: 'L1' }
  const phone = {
    callerScope: { kind: 'mobile', delegated: true },
    pairedDeviceId: 'phone-7'
  } as const

  function phoneRuntime() {
    let saved = makeTestBot({ members: [dana, lin] })
    const bots = {
      update: vi.fn(async (_botId: string, updates: BotUpdateParams['updates']) => {
        saved = applyBotUpdates(saved, updates)
        return saved
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only runtime.bots and the runtime id, which the stub provides.
    const runtime = { getRuntimeId: () => 'test-runtime', bots } as unknown as OrcaRuntimeService
    return { bots, dispatcher: new RpcDispatcher({ runtime, methods: BOT_METHODS }) }
  }

  it("lets the owner's phone replace the member list and change permissions", async () => {
    const { dispatcher } = phoneRuntime()

    expect(
      await dispatcher.dispatch(
        request('bots.update', {
          botId: 'bot-1',
          updates: { members: [lin], permissionMode: 'full-access' }
        }),
        phone
      )
    ).toMatchObject({
      ok: true,
      result: { bot: { members: [lin], permissionMode: 'full-access' } }
    })
  })

  it.each([
    ['add a person', { addMembers: [{ id: 'U9', name: 'Nora', source: 'slack' }] }],
    ['replace the member list', { members: [dana] }],
    ['change permissions', { permissionMode: 'full-access' }]
  ])("refuses an agent's CLI that tries to %s", async (_label, updates) => {
    const { bots, dispatcher } = phoneRuntime()

    expect(
      await dispatcher.dispatch(request('bots.update', { botId: 'bot-1', updates }), {
        caller: LOCAL_CLI_RPC_CALLER
      })
    ).toMatchObject({ ok: false })
    expect(bots.update).not.toHaveBeenCalled()
  })

  it("lets an agent's CLI pause a bot and remove a member", async () => {
    const { dispatcher } = phoneRuntime()

    expect(
      await dispatcher.dispatch(
        request('bots.update', {
          botId: 'bot-1',
          updates: { paused: true, removeMembers: [{ id: 'U1', source: 'slack' }] }
        }),
        { caller: LOCAL_CLI_RPC_CALLER }
      )
    ).toMatchObject({ ok: true, result: { bot: { paused: true, members: [lin] } } })
  })

  it('takes one person off Who can ask, on that service only, and records the device', async () => {
    const { dispatcher } = phoneRuntime()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    const response = await dispatcher.dispatch(
      request('bots.update', {
        botId: 'bot-1',
        updates: { removeMember: { id: 'U1', source: 'slack' } }
      }),
      phone
    )

    expect(response).toMatchObject({ ok: true, result: { bot: { members: [lin] } } })
    expect(info).toHaveBeenCalledWith(
      '[bots] person removed from Who can ask',
      expect.objectContaining({ botId: 'bot-1', memberId: 'U1', deviceId: 'phone-7' })
    )
    info.mockRestore()
  })
})

describe('bots.update resuming a bot', () => {
  it('releases held mail for a resume sent while the pause is still being saved', async () => {
    let saved = makeTestBot()
    let lane: Promise<unknown> = Promise.resolve()
    // The controller's one update lane: each edit saves after the one before it.
    const bots = {
      list: () => [saved],
      update: vi.fn((_botId: string, updates: BotUpdateParams['updates']) => {
        const done = lane.then(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
          saved = applyBotUpdates(saved, updates)
          return saved
        })
        lane = done
        return done
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only runtime.bots and the runtime id, which the stub provides.
    const runtime = { getRuntimeId: () => 'test-runtime', bots } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BOT_METHODS })
    releaseHeldBotMail.mockClear()

    await Promise.all([
      dispatcher.dispatch(request('bots.update', { botId: 'bot-1', updates: { paused: true } })),
      dispatcher.dispatch(request('bots.update', { botId: 'bot-1', updates: { paused: false } }))
    ])

    expect(saved.paused).toBe(false)
    expect(releaseHeldBotMail).toHaveBeenCalledOnce()
  })
})

describe('bots.activity', () => {
  it('refuses a bot this host does not have', async () => {
    const bots = { list: vi.fn(() => []) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a missing bot is refused before any other runtime read.
    const runtime = { getRuntimeId: () => 'test-runtime', bots } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BOT_METHODS })

    expect(await dispatcher.dispatch(request('bots.activity', { botId: 'missing' }))).toMatchObject(
      { ok: false, error: { message: expect.stringContaining('bot_not_found') } }
    )
  })
})

describe('bots.delete', () => {
  it("refuses before anything goes when the bot's home holds an unsaved editor draft", async () => {
    const bot = makeTestBot({ id: 'b1', folderWorkspaceId: 'home-1' })
    const draft = { filePath: '/bots/b1/SOUL.md', dirtyDraftContent: 'unsaved' }
    const store = {
      getFolderWorkspaces: () => [{ id: 'home-1' }],
      getWorkspaceSessionHostIds: () => ['local'],
      getWorkspaceSession: () => ({ openFilesByWorktree: { 'folder:home-1': [draft] } })
    }
    const bots = { list: () => [bot], delete: vi.fn(async () => ({ deleted: true })) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a refused delete reads only runtime.bots and the store's folder rows and session, which the stub provides.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      requireStore: () => store,
      bots
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BOT_METHODS })

    expect(await dispatcher.dispatch(request('bots.delete', { botId: 'b1' }))).toMatchObject({
      ok: false,
      error: { message: 'Unsaved editor changes. Save or close them in Orca, then delete again.' }
    })
    expect(forgetDeletedBotTools).not.toHaveBeenCalled()
    expect(bots.delete).not.toHaveBeenCalled()
  })
})

describe('bots.access.decide', () => {
  it("answers as this host's account for a paired phone, recording that phone", async () => {
    const { cloud, decisions } = fakeAccessCloud([makeAccessRequest()])
    const bot = makeTestBot({ slack: { appId: 'A1', teamId: 'T1' } })
    const bots = { list: () => [bot], update: vi.fn() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only runtime.bots, the connector cloud and the runtime id, which the stub provides.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      bots,
      getUIState: () => ({}),
      getConnectorCloud: () => cloud
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BOT_ACCESS_METHODS })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    const response = await dispatcher.dispatch(
      request('bots.access.decide', { requestId: 'req-1', decision: 'declined' }),
      { callerScope: { kind: 'mobile', delegated: true }, pairedDeviceId: 'phone-7' }
    )

    expect(response).toMatchObject({ ok: true, result: { ok: true } })
    expect(decisions).toHaveLength(1)
    expect(info).toHaveBeenCalledWith(
      '[bots] access request answered',
      expect.objectContaining({ deviceId: 'phone-7' })
    )
    info.mockRestore()
  })

  it("refuses an agent's CLI that answers an access request", async () => {
    const { cloud, decisions } = fakeAccessCloud([makeAccessRequest()])
    const bot = makeTestBot({ slack: { appId: 'A1', teamId: 'T1' } })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only runtime.bots, the connector cloud and the runtime id, which the stub provides.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      bots: { list: () => [bot], update: vi.fn() },
      getUIState: () => ({}),
      getConnectorCloud: () => cloud
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BOT_ACCESS_METHODS })
    vi.spyOn(console, 'info').mockImplementation(() => {})

    expect(
      await dispatcher.dispatch(
        request('bots.access.decide', { requestId: 'req-1', decision: 'declined' }),
        { caller: LOCAL_CLI_RPC_CALLER }
      )
    ).toMatchObject({ ok: false })
    expect(decisions).toHaveLength(0)
  })

  it("refreshes the host's store once after deciding, and lists from it without the cloud", async () => {
    const { cloud, call } = fakeAccessCloud([makeAccessRequest()])
    const bot = makeTestBot({ slack: { appId: 'A1', teamId: 'T1' } })
    const botAccessWatch = {
      list: vi.fn(async () => ({ ok: true as const, value: [] })),
      answered: vi.fn(async () => {})
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the methods read only runtime.bots, the connector cloud, the store and the runtime id, which the stub provides.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      bots: { list: () => [bot], update: vi.fn() },
      getUIState: () => ({}),
      getConnectorCloud: () => cloud,
      botAccessWatch
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: BOT_ACCESS_METHODS })
    vi.spyOn(console, 'info').mockImplementation(() => {})

    await dispatcher.dispatch(
      request('bots.access.decide', { requestId: 'req-1', decision: 'declined' }),
      { caller: DESKTOP_RPC_CALLER }
    )
    const decisionCalls = call.mock.calls.length
    expect(await dispatcher.dispatch(request('bots.access.list', null))).toMatchObject({
      ok: true,
      result: { ok: true, value: [] }
    })

    expect(botAccessWatch.answered).toHaveBeenCalledExactlyOnceWith('req-1')
    expect(call.mock.calls.length).toBe(decisionCalls)
    vi.restoreAllMocks()
  })
})

describe('bots.chat.reset (New Home Chat)', () => {
  function resetRuntime(delivered = false) {
    const bot = makeTestBot({ id: 'b1', chatSessionId: 'home-1' })
    chats.homes = new Map([
      ['home-1', 'b1'],
      ['thread-1', 'b1']
    ])
    chats.reset.mockClear()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only runtime.bots and the runtime id; the Chat reset is mocked.
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      // Whether the caller's turn is a connector delivery (the owner's Slack DM, say).
      getExternalConversationSeam: () => ({ deliveredTurn: () => delivered }),
      bots: { assertEnabled: () => {}, list: () => [bot] }
    } as unknown as OrcaRuntimeService
    return new RpcDispatcher({ runtime, methods: BOT_METHODS })
  }

  it('starts a new Home Chat for the owner, from Orca or a script', async () => {
    const dispatcher = resetRuntime()
    expect(await dispatcher.dispatch(request('bots.chat.reset', { botId: 'b1' }))).toMatchObject({
      ok: true,
      result: { sessionId: 'home-2' }
    })
    expect(chats.reset).toHaveBeenCalledWith('b1')
  })

  it('starts one from the Home Chat on a turn a connector delivered', async () => {
    const dispatcher = resetRuntime(true)
    expect(
      await dispatcher.dispatch(request('bots.chat.reset', { callerSessionId: 'home-1' }))
    ).toMatchObject({ ok: true, result: { sessionId: 'home-2' } })
    expect(chats.reset).toHaveBeenCalledWith('b1')
  })

  it("refuses another of the bot's chats", async () => {
    const dispatcher = resetRuntime()
    expect(
      await dispatcher.dispatch(
        request('bots.chat.reset', { botId: 'b1', callerSessionId: 'thread-1' })
      )
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining('Home Chat') } })
    expect(chats.reset).not.toHaveBeenCalled()
  })

  it('says so when the old Home Chat could not be stopped', async () => {
    const dispatcher = resetRuntime()
    chats.reset.mockRejectedValueOnce(new Error('bot_chat_close_failed: still attached'))
    expect(await dispatcher.dispatch(request('bots.chat.reset', { botId: 'b1' }))).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('bot_chat_close_failed') }
    })
  })

  it('takes a paired client by the bot it names, never by a session it claims', async () => {
    const dispatcher = resetRuntime()
    const phone = { callerScope: { kind: 'mobile', delegated: true }, pairedDeviceId: 'p' } as const
    expect(
      await dispatcher.dispatch(
        request('bots.chat.reset', { botId: 'b1', callerSessionId: 'thread-1' }),
        phone
      )
    ).toMatchObject({ ok: true, result: { sessionId: 'home-2' } })
    expect(
      await dispatcher.dispatch(request('bots.chat.reset', { callerSessionId: 'home-1' }), phone)
    ).toMatchObject({ ok: false })
  })
})

describe('bots.roster', () => {
  const ranger = makeTestBot({ id: 'ranger', name: 'Ranger' })
  const docs = makeTestBot({ id: 'docs', name: 'Docs' })
  const entry = (bot: Bot) => ({
    id: bot.id,
    name: bot.name,
    agent: bot.agent,
    paused: false,
    specialty: null,
    linked: []
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bots.roster reads only these runtime members.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    ensureStructuredAgentSessionHost: async () => undefined,
    getOrchestrationDb: () => ({}),
    bots: { list: () => [ranger, docs], roster: async () => [entry(ranger), entry(docs)] }
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: BOT_METHODS })

  it('marks the calling bot', async () => {
    chats.homes.set('ranger-chat', 'ranger')
    expect(
      await dispatcher.dispatch(request('bots.roster', { callerSessionId: 'ranger-chat' }))
    ).toMatchObject({
      ok: true,
      result: { bots: [{ ...entry(ranger), self: true }, entry(docs)] }
    })
  })

  it('lists every bot for a caller that is no bot, omitting chat summaries on request', async () => {
    const bots = [entry(ranger), entry(docs)]
    const listed = await dispatcher.dispatch(request('bots.roster', {}))
    expect(listed).toMatchObject({
      ok: true,
      result: { bots: bots.map((bot) => ({ ...bot, chats: { count: 0, home: false } })) }
    })
    expect(await dispatcher.dispatch(request('bots.roster', { withoutChats: true }))).toEqual({
      ...listed,
      result: { bots }
    })
  })
})
