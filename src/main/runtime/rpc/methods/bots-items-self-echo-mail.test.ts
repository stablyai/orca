import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { BOT_ITEM_MAIL_SENDER } from '../../../../shared/bots/bot-item-note-runs'
import type { AgentJournalBotItemNoteItem } from '../../../../shared/bots/bot-item-note'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { BotItemsStore } from '../../../bots/bot-items-store'
import type { BotItemMail } from '../../../bots/bot-items-schema'
import { createTrackedJournalOpener } from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { structuredAgentStartJournal } from '../../../native-chat/agent-session-wire/acquisition/structured-agent-start-journal'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../../../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { agentSessionRecordFixture } from '../../../native-chat/testing/agent-session-record-test-fixture'
import { openTestAgentSessionDatabase } from '../../agent-session/records/agent-session-record-store-test-harness'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { botItemMailId, sendBotItemMail } from './bots-items-mail'

const HOME = '54889ba4-947c-4531-8221-8ab6aea262a9'
const SIBLING = 'eae99fff-0cb1-49a9-877d-b90ceb29375a'
const THREAD = '2b86d615-52cf-490c-9514-563960ec11d0'
const OTHER_BOT_CHAT = '9745ea23-ea63-43d8-9a38-7ac457e021b7'

const BOT_ID = 'repair-bot'
const OTHER_BOT_ID = 'review-bot'

const HOME_ACTOR = { kind: 'bot', botId: BOT_ID, chatId: HOME } as const
const SIBLING_ACTOR = { kind: 'bot', botId: BOT_ID, chatId: SIBLING } as const
const THREAD_ACTOR = { kind: 'bot', botId: BOT_ID, chatId: THREAD } as const
const OTHER_BOT_ACTOR = { kind: 'bot', botId: OTHER_BOT_ID, chatId: OTHER_BOT_CHAT } as const
const OWNER_ACTOR = { kind: 'owner' } as const

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  const fn = cleanup
  cleanup = null
  setStructuredAgentSessionHost(null)
  await fn?.()
})

async function createRig() {
  const dir = await mkdtemp(join(tmpdir(), 'orca-item-self-echo-'))
  const itemDbPath = join(dir, 'items.sqlite')
  const orchDbPath = join(dir, 'orchestration.sqlite')

  let items = BotItemsStore.open(itemDbPath)
  let mail = new OrchestrationDb(orchDbPath)
  let journals = createTrackedJournalOpener()

  const bot = {
    id: BOT_ID,
    name: 'Repair Bot',
    folderWorkspaceId: 'bot-home',
    agent: 'codex' as const,
    chatSessionId: HOME
  }
  const otherBot = {
    id: OTHER_BOT_ID,
    name: 'Review Bot',
    folderWorkspaceId: 'other-bot-home',
    agent: 'codex' as const,
    chatSessionId: OTHER_BOT_CHAT
  }

  const chatTitles = new Map<string, string>([
    [HOME, 'Home Chat'],
    [SIBLING, 'Sibling Chat'],
    [THREAD, 'Support Thread'],
    [OTHER_BOT_CHAT, 'Review Home']
  ])

  const buildRecords = () =>
    new Map(
      [HOME, SIBLING, THREAD, OTHER_BOT_CHAT].map((sessionId) => {
        const workspaceId = folderWorkspaceKey(
          sessionId === OTHER_BOT_CHAT ? otherBot.folderWorkspaceId : bot.folderWorkspaceId
        )
        const title = chatTitles.get(sessionId)
        const record = agentSessionRecordFixture({
          sessionId,
          ...(title ? { conversationName: title } : {}),
          location: { workspaceId }
        })
        return [sessionId, { record, view: agentSessionConversationView(record) }]
      })
    )

  let rotateContextOnNextEpochRead = false

  const mountHost = async () => {
    const records = buildRecords()
    const journalDb = await openTestAgentSessionDatabase(dir)
    const openedJournals = new Map<string, Awaited<ReturnType<typeof journals.open>>>()
    for (const [sessionId, { record }] of records) {
      openedJournals.set(
        sessionId,
        await journals.open({
          identity: {
            sessionId,
            workspaceId: record.location.workspaceId,
            hostId: 'local',
            agent: 'codex',
            providerHandle: codexProviderHandle(`thread-${sessionId}`)
          },
          stateDirectory: dir
        })
      )
    }

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only record reads and journalDatabase are used by structuredAgentStartJournal and botChatTakingMailNow.
    const hostDeps = {
      journalDatabase: {
        sessionEpoch: async (sessionId: string) => {
          const epoch = await journalDb.sessionEpoch(sessionId)
          if (rotateContextOnNextEpochRead && sessionId === HOME) {
            rotateContextOnNextEpochRead = false
            const entry = records.get(HOME)!
            const updated = agentSessionRecordFixture({
              sessionId: HOME,
              conversationName: 'Home Chat',
              providerContextBoundary: {
                operationId: 'context-rotated',
                afterFence: 0,
                clearedAt: 1_800_000_000_000
              },
              location: { workspaceId: entry.record.location.workspaceId }
            })
            records.set(HOME, { record: updated, view: agentSessionConversationView(updated) })
          }
          return epoch
        }
      },
      store: {
        getRecord: (id: string) => records.get(id)?.record ?? null,
        listRecords: () => [...records.values()].map((entry) => entry.record),
        getConversation: (id: string) => records.get(id)?.view ?? null,
        listConversations: () => [...records.values()].map((entry) => entry.view),
        isSessionTabRetired: () => false
      }
    } as unknown as StructuredAgentSessionHostDeps

    const startJournal = structuredAgentStartJournal(
      () => hostDeps,
      async (sessionId) => {
        const journal = openedJournals.get(sessionId)
        if (!journal) {
          throw new Error(`missing journal for ${sessionId}`)
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: appendAgentStart only accesses session.journal for non-bot notes.
        return { journal } as unknown as StructuredAgentSessionHostSession
      }
    )

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: provides the host store and start-journal ports exercised by sendBotItemMail.
    setStructuredAgentSessionHost({
      deps: hostDeps,
      ...startJournal
    } as unknown as StructuredAgentSessionHost)

    return openedJournals
  }

  let openedJournals = await mountHost()
  const wakes: { to: string; type: string }[] = []

  const makeRuntime = (): OrcaRuntimeService =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exercises sendBotItemMail against real item, orchestration, and journal SQLite stores.
    ({
      getOrchestrationDb: () => mail,
      ensureStructuredAgentSessionHost: async () => {},
      notifyMessageArrived: (to: string, type: string) => {
        wakes.push({ to, type })
      },
      lookAround: { botOfLook: () => null, botOfTidyUp: () => null },
      bots: { list: () => [bot, otherBot] },
      botItems: {
        openedStore: () => items,
        chatRootOf: (sessionId: string) => sessionId,
        chatSource: (
          target: { chatSessionId: string | null },
          chatId: string,
          root: (id: string) => string,
          title: string | null
        ) => {
          if (target.chatSessionId && root(target.chatSessionId) === chatId) {
            return { kind: 'home' as const, title: 'Home Chat' }
          }
          if (chatId === THREAD) {
            return { kind: 'thread' as const, title: 'Support Thread' }
          }
          return { kind: 'chat' as const, title }
        },
        owningChat: ({
          chatId,
          source
        }: {
          chatId: string
          source: { kind: 'home' | 'chat' | 'thread' | 'automation'; title: string | null }
        }) => ({
          id: chatId,
          kind: source.kind,
          title: chatTitles.get(chatId) ?? source.title
        }),
        views: async (records: { uid: string }[]) =>
          records.map((record) => ({
            uid: record.uid,
            links: items
              .links(record.uid)
              .map((link) => ({ kind: link.kind, ref: link.ref, pr: null }))
          }))
      }
    }) as unknown as OrcaRuntimeService

  let runtime = makeRuntime()

  const readNotes = async (sessionId: string): Promise<AgentJournalBotItemNoteItem[]> => {
    const journal = openedJournals.get(sessionId)!
    const rendered: AgentJournalRenderItem[] = []
    await journal.reads.visitItems({ kinds: ['bot-item-note'] }, (_id, _seq, _body, _attr, item) =>
      rendered.push(item)
    )
    return rendered.flatMap((item) => (item.body.kind === 'bot-item-note' ? [item.body] : []))
  }

  const restart = async () => {
    setStructuredAgentSessionHost(null)
    await journals.closeAll()
    items.dispose()
    mail.close()

    items = BotItemsStore.open(itemDbPath)
    mail = new OrchestrationDb(orchDbPath)
    journals = createTrackedJournalOpener()
    openedJournals = await mountHost()
    runtime = makeRuntime()
  }

  cleanup = async () => {
    setStructuredAgentSessionHost(null)
    await journals.closeAll()
    items.dispose()
    mail.close()
    await rm(dir, { recursive: true, force: true })
  }

  return {
    get items() {
      return items
    },
    get mail() {
      return mail
    },
    get runtime() {
      return runtime
    },
    wakes,
    readNotes,
    restart,
    rotateContextOnce: () => {
      rotateContextOnNextEpochRead = true
    }
  }
}

describe('sendBotItemMail same-bot sibling-chat self-echoes', () => {
  it('appends a passive botItemNote for same-bot sibling-chat updates without inserting orca:items mail or waking', async () => {
    const rig = await createRig()
    const { uid } = rig.items.add(
      {
        ownerBotId: BOT_ID,
        chatId: HOME,
        source: { kind: 'home', title: 'Home Chat' },
        title: 'Investigate flaky check',
        status: 'planned',
        links: []
      },
      HOME_ACTOR
    )

    rig.items.set(
      uid,
      { status: 'working', comment: 'Picked this up in the side chat.' },
      SIBLING_ACTOR
    )

    const [owed] = rig.items.owedMail(0).mails
    expect(owed).toBeDefined()
    expect(await sendBotItemMail(rig.runtime, owed!)).toBe(true)
    rig.items.markMailSent(owed!.changes.map(({ event }) => event.id))

    expect(rig.mail.getMessageById(botItemMailId(owed!.id))).toBeUndefined()
    expect(rig.wakes).toEqual([])
    expect(rig.items.owedMail(0).mails).toEqual([])

    const notes = await rig.readNotes(HOME)
    expect(notes).toEqual([
      {
        kind: 'bot-item-note',
        noteId: `m${owed!.id}`,
        by: { kind: 'chat', chatId: SIBLING, title: 'Sibling Chat' },
        entries: [
          expect.objectContaining({
            uid,
            event: 'commented',
            text: 'Picked this up in the side chat.'
          }),
          expect.objectContaining({
            uid,
            event: 'status',
            from: 'planned',
            to: 'working'
          })
        ]
      }
    ])
  })

  it('inserts orca:items mail and wakes immediately for owner answers including askedInConversation', async () => {
    const rig = await createRig()
    const { uid } = rig.items.add(
      {
        ownerBotId: BOT_ID,
        chatId: THREAD,
        source: { kind: 'thread', title: 'Support Thread' },
        title: 'Reply to customer thread',
        status: 'working',
        links: []
      },
      THREAD_ACTOR
    )

    rig.items.set(
      uid,
      {
        status: 'needs_you',
        askedInConversation: THREAD,
        ask: {
          questions: [{ prompt: 'Send the refund?', options: [{ label: 'Yes' }, { label: 'No' }] }]
        }
      },
      THREAD_ACTOR
    )

    rig.items.ownerComment(uid, 'Yes', OWNER_ACTOR)
    const [owed] = rig.items.owedMail(0).mails
    expect(owed).toBeDefined()

    expect(await sendBotItemMail(rig.runtime, owed!)).toBe(true)

    const sent = rig.mail.getMessageById(botItemMailId(owed!.id))
    expect(sent).toBeDefined()
    expect(sent?.from_handle).toBe(BOT_ITEM_MAIL_SENDER)
    expect(sent?.to_handle).toBe(`orca_session_id:${THREAD}`)
    expect(JSON.parse(sent!.payload!)).toMatchObject({ askedInConversation: THREAD })
    expect(rig.wakes).toEqual([{ to: `orca_session_id:${THREAD}`, type: 'status' }])

    const notes = await rig.readNotes(THREAD)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({
      kind: 'bot-item-note',
      noteId: `m${owed!.id}`,
      by: 'owner'
    })
  })

  it('inserts orca:items mail and wakes immediately for a mixed batch with same-bot and owner changes', async () => {
    const rig = await createRig()
    const { uid } = rig.items.add(
      {
        ownerBotId: BOT_ID,
        chatId: HOME,
        source: { kind: 'home', title: 'Home Chat' },
        title: 'Prepare release notes',
        status: 'working',
        links: []
      },
      HOME_ACTOR
    )

    rig.items.comment(uid, 'Drafted changelog section.', SIBLING_ACTOR)
    rig.items.ownerComment(uid, 'Include the migration callout too.', OWNER_ACTOR)

    const owedList = rig.items.owedMail(0).mails
    expect(owedList).toHaveLength(2)
    const mixed: BotItemMail = {
      id: owedList[0]!.id,
      ownerBotId: BOT_ID,
      chatId: HOME,
      changes: owedList.flatMap((entry) => entry.changes)
    }

    expect(await sendBotItemMail(rig.runtime, mixed)).toBe(true)

    const sent = rig.mail.getMessageById(botItemMailId(mixed.id))
    expect(sent).toBeDefined()
    expect(sent?.from_handle).toBe(BOT_ITEM_MAIL_SENDER)
    expect(sent?.subject).toContain('Your owner')
    expect(sent?.body).toContain('Drafted changelog section.')
    expect(sent?.body).toContain('Include the migration callout too.')
    expect(rig.wakes).toEqual([{ to: `orca_session_id:${HOME}`, type: 'status' }])

    const notes = await rig.readNotes(HOME)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({
      noteId: `m${mixed.id}`,
      by: 'owner'
    })
    expect(notes[0]?.entries).toHaveLength(2)
  })

  it("inserts orca:items mail and wakes immediately for another bot's change", async () => {
    const rig = await createRig()
    const { uid } = rig.items.add(
      {
        ownerBotId: BOT_ID,
        chatId: HOME,
        source: { kind: 'home', title: 'Home Chat' },
        title: 'Audit API latency',
        status: 'working',
        links: []
      },
      HOME_ACTOR
    )

    rig.items.link(uid, [{ kind: 'pr', ref: 'stablyai/orca#42' }], OTHER_BOT_ACTOR)
    const [owed] = rig.items.owedMail(0).mails
    expect(owed).toBeDefined()

    expect(await sendBotItemMail(rig.runtime, owed!)).toBe(true)

    const sent = rig.mail.getMessageById(botItemMailId(owed!.id))
    expect(sent).toBeDefined()
    expect(sent?.from_handle).toBe(BOT_ITEM_MAIL_SENDER)
    expect(sent?.subject).toContain('Another agent linked to it')
    expect(rig.wakes).toEqual([{ to: `orca_session_id:${HOME}`, type: 'status' }])

    const notes = await rig.readNotes(HOME)
    expect(notes).toEqual([
      expect.objectContaining({
        noteId: `m${owed!.id}`,
        by: 'other-agent'
      })
    ])
  })

  it('stays idempotent across retries and host restarts without duplicating passive UI notes', async () => {
    const rig = await createRig()
    const { uid } = rig.items.add(
      {
        ownerBotId: BOT_ID,
        chatId: HOME,
        source: { kind: 'home', title: 'Home Chat' },
        title: 'Clean up stale branches',
        status: 'working',
        links: []
      },
      HOME_ACTOR
    )

    rig.items.comment(uid, 'Pruned merged branches from side chat.', SIBLING_ACTOR)
    const [owed] = rig.items.owedMail(0).mails
    expect(owed).toBeDefined()

    // If the recipient chat clears/rotates context mid-capture, leave it owed so the retry writes the note.
    rig.rotateContextOnce()
    expect(await sendBotItemMail(rig.runtime, owed!)).toBe(false)
    expect(await rig.readNotes(HOME)).toHaveLength(0)

    // Retry succeeds + immediate in-process retry before markMailSent commits does not duplicate.
    expect(await sendBotItemMail(rig.runtime, owed!)).toBe(true)
    expect(await sendBotItemMail(rig.runtime, owed!)).toBe(true)
    expect(await rig.readNotes(HOME)).toHaveLength(1)
    expect(rig.wakes).toEqual([])
    expect(rig.mail.getMessageById(botItemMailId(owed!.id))).toBeUndefined()

    // Simulate crash before markMailSent: restart reopens SQLite stores with mail still 'owed'.
    await rig.restart()
    const [replayed] = rig.items.owedMail(0).mails
    expect(replayed?.id).toBe(owed!.id)
    expect(await sendBotItemMail(rig.runtime, replayed!)).toBe(true)
    rig.items.markMailSent(replayed!.changes.map(({ event }) => event.id))

    expect(await rig.readNotes(HOME)).toHaveLength(1)
    expect(rig.wakes).toEqual([])
    expect(rig.mail.getMessageById(botItemMailId(owed!.id))).toBeUndefined()

    // Restart after markMailSent: nothing remains owed.
    await rig.restart()
    expect(rig.items.owedMail(0).mails).toEqual([])
    expect(await rig.readNotes(HOME)).toHaveLength(1)
  })
})
