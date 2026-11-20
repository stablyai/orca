import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import { DESKTOP_RPC_CALLER } from '../callers/rpc-caller-identity'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { BotItemsHost, type BotItemsHostDeps } from '../../../bots/bot-items-runtime'
import type { BotItemMail } from '../../../bots/bot-items-schema'
import type { BotItemEvent } from '../../../../shared/bots/bot-items'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { BotsDbWorkerClient } from '../../../bots/db-worker/bots-db-worker-client'
import { closeBotsDbStores } from '../../../bots/db-worker/bots-db-worker-entry'
import { inProcessBotsDbWorker } from '../../../bots/db-worker/bots-db-worker.test-fixture'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { AgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import { setAgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { BOT_ITEMS_METHODS } from './bots-items'
import { checkedWorkerOrigin } from './bots-items-worker-origin'

const paths = vi.hoisted(() => ({ userData: '' }))
const RANGER_CHAT = vi.hoisted(() => '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e')
const DOCS_CHAT = vi.hoisted(() => '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d')
vi.mock('../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => paths.userData
}))

// Ranger's chat and its Look around run live in Ranger's home; Docs's chat lives in Docs's.
vi.mock('../../../bots/bot-session-tabs', () => ({
  botOfSession: (bots: { list: () => { id: string }[] }, sessionId: string) => {
    const botId =
      sessionId === RANGER_CHAT || sessionId === 'ranger-look'
        ? 'ranger'
        : sessionId === DOCS_CHAT
          ? 'docs'
          : null
    return bots.list().find((bot) => bot.id === botId) ?? null
  }
}))
vi.mock(
  import('../../orchestration/addressing/session-lineage/structured-session-lineage'),
  async (importOriginal) => ({
    ...(await importOriginal()),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the writer gate reads only a record's session id, location and name; the lineage reads list none.
    readAgentSessionRecordStore: (() => ({
      getRecord: (sessionId: string) =>
        sessionId === RANGER_CHAT || sessionId === DOCS_CHAT
          ? {
              sessionId,
              location: { workspaceId: 'folder:home' },
              conversationName: 'Chat'
            }
          : null,
      listRecords: () => []
    })) as never
  })
)
vi.mock(
  import('../orchestration/callers/orchestration-session-caller'),
  async (importOriginal) => ({
    ...(await importOriginal()),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mail path reads only the record's workspace id, which this stub sets.
    readActingSessionRecord: vi.fn(async (_runtime: unknown, sessionId: unknown) => ({
      sessionId: String(sessionId),
      record: { location: { workspaceId: 'ranger-home' } }
    })) as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: item writes read only the verified caller's session id, which this stub binds to the request's evidence.
    resolveOrchestrationSessionCaller: vi.fn(async (_runtime: unknown, request: RpcRequest) => {
      const sessionId = request.orchestrationCompatibilityEvidence?.agentSessionId
      return {
        request,
        caller: {
          kind: 'session',
          sessionId,
          address: `orca_session_id:${sessionId}`,
          terminalHandle: null,
          workspaceId: 'ranger-home'
        }
      }
    }) as never
  })
)
vi.mock(import('../../orchestration/addressing/orchestration-party'), async (importOriginal) => ({
  ...(await importOriginal()),
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mail path reads only the party's address, which this stub sets.
  resolveOrcaSessionParty: vi.fn((sessionId: string) => ({
    address: `orca_session_id:${sessionId}`,
    terminalHandle: null
  })) as never
}))
const itemChat = vi.hoisted((): { sessionId: string | null } => ({ sessionId: null }))
vi.mock(import('./bots-chats'), async (importOriginal) => ({
  ...(await importOriginal()),
  botChatTakingMail: vi.fn(async () =>
    itemChat.sessionId ? { title: null, sessionId: itemChat.sessionId } : null
  )
}))
const sendToBot = vi.hoisted(() => vi.fn())
vi.mock('./orchestration/messaging/bot-request-send', () => ({ sendToBot }))
const messages = new Map<string, { to_handle: string }>()
const mailed: { chatId: string; eventId: number; kind: string }[] = []

/** A CLI call from a session: its verified evidence is the chat it names unless `from` says otherwise. */
const request = (
  method: string,
  params?: { callerSessionId?: string } & Record<string, unknown>,
  from = params?.callerSessionId
): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method,
  params,
  ...(from ? { orchestrationCompatibilityEvidence: { agentSessionId: from } } : {})
})

let host: BotItemsHost | null = null

function itemsRuntime() {
  const bots = [
    makeTestBot({ id: 'ranger', name: 'Ranger' }),
    makeTestBot({ id: 'docs', name: 'Docs' })
  ]
  const db = {
    db: { prepare: () => ({ get: () => undefined }) },
    getMessageById: (id: string) => messages.get(id),
    getDispatchContextById: () => undefined
  }
  const deps = {
    workRuntime: { getOrchestrationDb: () => db },
    db: new BotsDbWorkerClient(inProcessBotsDbWorker().factory),
    bots: () => bots,
    githubCache: () => ({ pr: {}, issue: {} }),
    chatTitle: () => null,
    chatExists: () => true,
    chatRoot: (id: string) => id,
    threadChats: () => [],
    automationRunChats: () => [],
    notify: () => {},
    sendMail: async (mail: BotItemMail) => {
      mailed.push(
        ...mail.changes.map(({ event }) => ({
          chatId: mail.chatId,
          eventId: event.id,
          kind: event.kind
        }))
      )
      return true
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host reads only these fields of the work runtime and database.
  host = new BotItemsHost(deps as unknown as BotItemsHostDeps)
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    bots: { assertEnabled: () => {}, enabled: () => true, list: () => bots },
    lookAround: {
      botOfLook: (sessionId: string) => (sessionId === 'ranger-look' ? 'ranger' : null),
      botOfTidyUp: () => null
    },
    botItems: host,
    getOrchestrationDb: () => db,
    ensureStructuredAgentSessionHost: async () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods read only bots, lookAround, botItems, the orchestration database and the runtime id, which the stub provides.
  const service = runtime as unknown as OrcaRuntimeService
  return {
    dispatcher: new RpcDispatcher({ runtime: service, methods: BOT_ITEMS_METHODS }),
    host,
    service
  }
}

beforeEach(() => {
  paths.userData = mkdtempSync(join(tmpdir(), 'bot-items-rpc-'))
  sendToBot.mockReset()
  messages.clear()
  mailed.length = 0
  itemChat.sessionId = null
})

afterEach(() => {
  host?.dispose()
  host = null
  closeBotsDbStores()
  rmSync(paths.userData, { recursive: true, force: true })
})

describe('bot items over RPC', () => {
  it('lets a Look around run read its bot’s items but never write one', async () => {
    const { dispatcher } = itemsRuntime()
    const made = await dispatcher.dispatch(
      request('bots.items.add', { callerSessionId: RANGER_CHAT, title: 'Share dialog' })
    )
    expect(made).toMatchObject({ ok: true, result: { item: { number: 1, status: 'planned' } } })

    const refused = await dispatcher.dispatch(
      request('bots.items.add', { callerSessionId: 'ranger-look', title: 'From a look' })
    )
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(
      await dispatcher.dispatch(
        request('bots.items.comment', { callerSessionId: 'ranger-look', item: '1', text: 'Hi' })
      )
    ).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })

    const listed = await dispatcher.dispatch(
      request('bots.items.list', { callerSessionId: 'ranger-look' })
    )
    expect(listed).toMatchObject({
      ok: true,
      result: { items: [{ number: 1, title: 'Share dialog' }] }
    })
  })

  it('makes no item for a bot that refuses the request', async () => {
    const { dispatcher } = itemsRuntime()
    sendToBot.mockRejectedValue(new OrchestrationError('bot_paused', 'Docs is paused.'))

    const refused = await dispatcher.dispatch(
      request('bots.items.add', {
        callerSessionId: RANGER_CHAT,
        title: 'Fix the onboarding invite link',
        forBot: 'bot:Docs'
      })
    )

    expect(refused).toMatchObject({
      ok: false,
      error: { message: 'Docs is paused.' }
    })
    expect(sendToBot).toHaveBeenCalledTimes(1)
    expect(
      await dispatcher.dispatch(request('bots.items.list', { botId: 'docs', all: true }))
    ).toMatchObject({ ok: true, result: { items: [] } })
  })

  it('refuses an item for another bot that the store would refuse, before sending its request', async () => {
    const { dispatcher } = itemsRuntime()

    const refused = await dispatcher.dispatch(
      request('bots.items.add', {
        callerSessionId: RANGER_CHAT,
        title: 'x'.repeat(201),
        forBot: 'bot:Docs'
      })
    )

    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(sendToBot).not.toHaveBeenCalled()
  })

  it('makes an item with deduplicated links in the chat its request landed in', async () => {
    const { dispatcher } = itemsRuntime()
    sendToBot.mockImplementation(
      async (_context: unknown, mail: { messageId: string; to: string }) => {
        expect(mail.to).toBe('bot:Docs')
        messages.set(mail.messageId, { to_handle: `orca_session_id:${DOCS_CHAT}` })
        return { receipt: {}, nudge: () => {} }
      }
    )

    const made = await dispatcher.dispatch(
      request('bots.items.add', {
        callerSessionId: RANGER_CHAT,
        title: 'Fix the onboarding invite link',
        forBot: 'bot:Docs',
        links: Array.from({ length: 51 }, () => 'https://example.com/spec')
      })
    )

    expect(made).toMatchObject({
      ok: true,
      result: {
        item: {
          owner: { botId: 'docs' },
          chat: { id: DOCS_CHAT },
          madeBy: { botId: 'ranger', chatId: RANGER_CHAT },
          links: [{ kind: 'url', ref: 'https://example.com/spec' }]
        }
      }
    })
    expect(sendToBot).toHaveBeenCalledOnce()
  })

  it("mails the item's chat once for each owner change, a close with nothing running included", async () => {
    const { dispatcher } = itemsRuntime()
    await dispatcher.dispatch(
      request('bots.items.add', { callerSessionId: RANGER_CHAT, title: 'Share dialog' })
    )

    const desktop = { caller: DESKTOP_RPC_CALLER }
    await dispatcher.dispatch(
      request('bots.items.owner.comment', { item: '1', text: 'Use the short link' }),
      desktop
    )
    await dispatcher.dispatch(
      request('bots.items.owner.status', { items: ['1'], status: 'done' }),
      desktop
    )
    await host!.sendOwedMail()

    expect(mailed).toEqual([
      { chatId: RANGER_CHAT, eventId: 2, kind: 'commented' },
      { chatId: RANGER_CHAT, eventId: 3, kind: 'status' }
    ])
  })

  it('posts a hard-to-read ask as written and tips the bot; a clean ask gets no tip', async () => {
    const { dispatcher } = itemsRuntime()
    for (const title of ['Go ahead', 'Go ahead too']) {
      await dispatcher.dispatch(request('bots.items.add', { callerSessionId: RANGER_CHAT, title }))
    }
    const prose = 'Go ahead without review? Reply **yes**, or **wait**.'

    const tipped = await dispatcher.dispatch(
      request('bots.items.set', {
        callerSessionId: RANGER_CHAT,
        item: '1',
        status: 'needs_you',
        comment: prose
      })
    )
    const clean = await dispatcher.dispatch(
      request('bots.items.set', {
        callerSessionId: RANGER_CHAT,
        item: '2',
        status: 'needs_you',
        ask: {
          questions: [{ prompt: 'Go ahead?', options: [{ label: 'Go' }, { label: 'Wait' }] }]
        }
      })
    )
    const shown = await dispatcher.dispatch(
      request('bots.items.show', { callerSessionId: RANGER_CHAT, item: '1', newest: true })
    )

    expect(tipped).toMatchObject({
      ok: true,
      result: {
        item: { status: 'needs_you', question: { text: prose } },
        advice: {
          codes: ['prose_choices'],
          tip: 'Posted. Tip: Give the choices as --option values after --ask, so they show as quick replies. Set Needs you again if you rewrite it.'
        }
      }
    })
    expect(clean).toMatchObject({ ok: true, result: { item: { status: 'needs_you' } } })
    expect(clean).not.toHaveProperty('result.advice')
    expect(shown).toMatchObject({
      ok: true,
      result: {
        events: expect.arrayContaining([
          expect.objectContaining({ kind: 'commented', data: { text: prose } })
        ])
      }
    })
  })

  it("takes a paired client's store image on a comment, claimed for the item's live chat, and nothing outside the store", async () => {
    const { dispatcher } = itemsRuntime()
    const store = new AgentSessionAttachmentStore(
      join(paths.userData, 'agent-session-attachments'),
      {
        hasSession: () => true
      }
    )
    const claimed: string[] = []
    setAgentSessionAttachmentStore(store, async (sessionId) => {
      claimed.push(sessionId)
    })
    itemChat.sessionId = 'ranger-live'
    try {
      await dispatcher.dispatch(
        request('bots.items.add', { callerSessionId: RANGER_CHAT, title: 'Share dialog' })
      )
      const shot = join(store.rootDir, '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01', 'shot.png')
      mkdirSync(dirname(shot), { recursive: true })
      writeFileSync(shot, Buffer.alloc(4))
      const outside = join(paths.userData, 'secret.png')
      writeFileSync(outside, 'x')
      const server = {
        caller: { kind: 'paired-device' as const, deviceId: 'desktop-2' },
        pairedDeviceId: 'desktop-2',
        clientKind: 'runtime' as const
      }

      expect(
        await dispatcher.dispatch(
          request('bots.items.owner.comment', { item: '1', text: '', images: [outside] }),
          server
        )
      ).toMatchObject({ ok: false })
      expect(
        await dispatcher.dispatch(
          request('bots.items.owner.comment', { item: '1', text: '', images: [shot] }),
          server
        )
      ).toMatchObject({ ok: true })
      expect(claimed).toEqual(['ranger-live'])
      const shown = await dispatcher.dispatch(
        request('bots.items.owner.show', { item: '1', newest: true }),
        server
      )
      // This host's own window may name an image on disk: it is copied into the store first.
      expect(
        await dispatcher.dispatch(
          request('bots.items.owner.comment', { item: '1', text: 'From disk', images: [outside] }),
          { caller: DESKTOP_RPC_CALLER, clientKind: 'runtime' }
        )
      ).toMatchObject({ ok: true })
      expect(claimed).toEqual(['ranger-live', 'ranger-live'])
      expect(shown).toMatchObject({
        ok: true,
        result: {
          events: expect.arrayContaining([
            expect.objectContaining({
              kind: 'commented',
              data: { text: '', images: [{ path: shot, name: 'shot.png', bytes: 4 }] }
            })
          ])
        }
      })
    } finally {
      setAgentSessionAttachmentStore(null)
      itemChat.sessionId = null
    }
  })

  it("attaches a bot's --file files to its comment and its status comment; one unreadable file posts nothing", async () => {
    const { dispatcher } = itemsRuntime()
    const store = new AgentSessionAttachmentStore(
      join(paths.userData, 'agent-session-attachments'),
      { hasSession: () => true }
    )
    const claim = vi.fn(async (_sessionId: string, _body: AgentJournalMessageItem) => undefined)
    setAgentSessionAttachmentStore(store, claim)
    itemChat.sessionId = 'ranger-live'
    try {
      await dispatcher.dispatch(
        request('bots.items.add', { callerSessionId: RANGER_CHAT, title: 'Install dialog' })
      )
      const shot = join(paths.userData, 'after.png')
      const log = join(paths.userData, 'run.log')
      writeFileSync(shot, Buffer.alloc(4))
      writeFileSync(log, 'ok')
      const comment = (params: Record<string, unknown>) =>
        dispatcher.dispatch(
          request('bots.items.comment', { callerSessionId: RANGER_CHAT, item: '1', ...params })
        )

      expect(
        await comment({ text: 'Fixed.', files: [shot, join(paths.userData, 'gone.png')] })
      ).toMatchObject({
        ok: false,
        error: { message: "gone.png can't be read. Nothing was posted." }
      })
      expect(await comment({ text: '', files: [shot, log] })).toMatchObject({ ok: true })
      expect(
        await dispatcher.dispatch(
          request('bots.items.set', {
            callerSessionId: RANGER_CHAT,
            item: '1',
            status: 'needs_you',
            comment: 'Which one?',
            files: [shot]
          })
        )
      ).toMatchObject({ ok: true })
      // What the write would refuse is refused before a file is copied or claimed.
      expect(await comment({ text: 'x'.repeat(7_990), files: [log] })).toMatchObject({
        ok: false,
        error: {
          message: expect.stringMatching(/^The comment and its files' paths come to \d+ characters/)
        }
      })
      expect(
        await dispatcher.dispatch(
          request('bots.items.set', {
            callerSessionId: RANGER_CHAT,
            item: '1',
            status: 'canceled',
            comment: 'Dropping it.',
            files: [shot]
          })
        )
      ).toMatchObject({ ok: false, error: { message: 'Canceling needs a reason: --reason "..."' } })
      expect(claim).toHaveBeenCalledTimes(2)
      const shown = await dispatcher.dispatch(
        request('bots.items.show', { callerSessionId: RANGER_CHAT, item: '1' })
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a successful bots.items.show reply carries its events, which the matcher below checks.
      const { events } = (shown as { result: { events: BotItemEvent[] } }).result
      const comments = events.filter((event) => event.kind === 'commented')
      expect(comments).toHaveLength(2)
      expect(comments[0]?.data.images).toMatchObject([
        { name: 'after.png', bytes: 4, path: expect.stringContaining(store.rootDir) }
      ])
      expect(comments[0]?.data.text).toMatch(/^@\S+agent-session-attachments\S+run\.log$/)
      expect(claim).toHaveBeenNthCalledWith(1, 'ranger-live', {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: comments[0]?.data.text },
          { type: 'image-ref', path: comments[0]?.data.images?.[0]?.path }
        ]
      })
      expect(claim).toHaveBeenNthCalledWith(2, 'ranger-live', expect.anything())
      expect(comments[1]?.data).toMatchObject({
        text: 'Which one?',
        images: [{ name: 'after.png', bytes: 4 }]
      })
    } finally {
      setAgentSessionAttachmentStore(null)
      itemChat.sessionId = null
    }
  })

  it('writes as the calling bot only: a terminal outside a bot chat is refused', async () => {
    const { dispatcher } = itemsRuntime()

    expect(
      await dispatcher.dispatch(request('bots.items.add', { title: 'From a terminal' }))
    ).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  })

  it("refuses a write naming a bot chat that isn't the verified caller", async () => {
    const { dispatcher } = itemsRuntime()

    expect(
      await dispatcher.dispatch(
        request('bots.items.add', { callerSessionId: RANGER_CHAT, title: 'Posing' }, DOCS_CHAT)
      )
    ).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(
      await dispatcher.dispatch(request('bots.items.list', { botId: 'ranger', all: true }))
    ).toMatchObject({ ok: true, result: { items: [] } })
  })

  it("records a worker's item only for the calling bot's own open item", async () => {
    const { dispatcher, service } = itemsRuntime()
    await dispatcher.dispatch(
      request('bots.items.add', { callerSessionId: RANGER_CHAT, title: 'Share dialog' })
    )
    await dispatcher.dispatch(
      request('bots.items.add', { callerSessionId: DOCS_CHAT, title: 'Docs page' })
    )
    const uid = (await service.botItems.store().byNumber(1))?.uid
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only the caller's session id.
    const caller = { sessionId: RANGER_CHAT } as never
    const context = { runtime: service, orchestrationCaller: caller }

    expect(await checkedWorkerOrigin('bot-item:1', context)).toMatchObject({
      origin: `bot-item:${uid}`,
      linkedItem: { number: 1, title: 'Share dialog' }
    })
    await expect(checkedWorkerOrigin('bot-item:2', context)).rejects.toThrow(/another bot/)
    await expect(
      checkedWorkerOrigin('bot-item:1', { runtime: service, orchestrationCaller: undefined })
    ).rejects.toThrow(/Only a bot writes items/)
  })

  it("sends the --for maker's comment as its request to the item's chat, never another", async () => {
    const { dispatcher } = itemsRuntime()
    sendToBot.mockImplementation(async (_context: unknown, mail: { messageId: string }) => {
      messages.set(mail.messageId, { to_handle: `orca_session_id:${DOCS_CHAT}` })
      return { receipt: {}, nudge: () => {} }
    })
    await dispatcher.dispatch(
      request('bots.items.add', {
        callerSessionId: RANGER_CHAT,
        title: 'Docs page',
        forBot: 'Docs'
      })
    )
    sendToBot.mockClear()
    mailed.length = 0
    const comment = (text: string) =>
      dispatcher.dispatch(
        request('bots.items.comment', { callerSessionId: RANGER_CHAT, item: '1', text })
      )

    expect(await comment('Closed chat')).toMatchObject({
      ok: false,
      error: { code: 'item_closed' }
    })
    expect(sendToBot).not.toHaveBeenCalled()

    itemChat.sessionId = DOCS_CHAT
    expect(await comment('v2 spec')).toMatchObject({ ok: true })
    expect(sendToBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        to: `orca_session_id:${DOCS_CHAT}`,
        keepChat: true,
        params: expect.objectContaining({
          type: 'status',
          subject: expect.stringMatching(/^Ranger commented/)
        })
      })
    )
    await host!.sendOwedMail()
    expect(mailed).toEqual([])

    sendToBot.mockRejectedValueOnce(new OrchestrationError('bot_paused', 'Docs is paused.'))
    expect(await comment('Again')).toMatchObject({
      ok: false,
      error: { message: 'Docs is paused.' }
    })
    expect(
      await dispatcher.dispatch(
        request('bots.items.set', { callerSessionId: RANGER_CHAT, item: '1', title: 'Mine' })
      )
    ).toMatchObject({ ok: false, error: { code: 'not_owner' } })
  })
})
