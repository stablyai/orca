import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { OWNER_ACTS_FOR, type BotRequestAsker } from '../../../../shared/bots/bot-acts-for'
import { BotChats } from '../../../../shared/rpc-contract/bots-params'
import {
  AttachmentReadParams,
  AttachmentUploadStartParams
} from '../../../../shared/rpc-contract/structured-agent-session/agent-session-attachment-params'
import { emptyChatReusableBy } from '../../../bots/team-share/bot-share-chats'
import {
  HistoryParams,
  RespondParams
} from '../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { BotShareCallerScope } from '../callers/rpc-caller-scope'
import {
  BOT_SHARE_SCOPED_METHODS,
  SHARE_BY_ATTACHMENT,
  SHARE_BY_BOT,
  SHARE_BY_BOT_FOLDER,
  SHARE_BY_ENVELOPE_SESSION,
  SHARE_BY_SESSION
} from '../../../../shared/bots/bot-share-rpc-methods'
import { FileDirRead, FileTreePath } from '../../../../shared/rpc-contract/filesystem/files-params'
import { confinedFolderRead, confinedFolderWatch } from '../methods/files/files-bot-folder-read'
import { FileOpen } from '../../../../shared/rpc-contract/filesystem/files-target-params'
import {
  BotSlackBot,
  BotSlackSetUp
} from '../../../../shared/rpc-contract/bots-connector-setup-params'
import { botShareMethodNames } from '../methods/rpc-method-share'
import { defineMethod } from '../core'
import { AgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import { setAgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { RpcDispatcher } from '../dispatcher'
import { ALL_RPC_METHODS } from '../methods/rpc-method-registry'
import { STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS } from '../methods/structured-sessions/catalog/structured-agent-session-options-read'
import { STRUCTURED_AGENT_SESSION_PROMPT_RESPONSE_METHODS } from '../methods/structured-sessions/conversation/structured-agent-session-prompt-response'
import { BOT_METHODS } from '../methods/bots'
import { STATUS_METHODS } from '../methods/host-management/status'
import { STRUCTURED_AGENT_SESSION_STATUS_METHODS } from '../methods/structured-sessions/subscriptions/structured-agent-session-status-stream'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { BotItemsStore } from '../../../bots/bot-items-store'
import type { BotItemRecord } from '../../../bots/bot-items-schema'
import { BOT_ITEMS_OWNER_METHODS } from '../methods/bots-items-owner-methods'
import { botPeoplePicker } from '../../../../shared/bots/bot-chat-people'

const SHARED = { id: 'bot-shared', folderWorkspaceId: 'home-shared' }
const OTHER = { id: 'bot-other', folderWorkspaceId: 'home-other' }
const SCOPE: BotShareCallerScope = {
  kind: 'bot-share',
  botId: SHARED.id,
  accountId: 'acct-alice'
}
const alice: BotRequestAsker = {
  kind: 'person',
  source: 'orca',
  userId: 'acct-alice',
  workspaceId: null,
  role: 'member'
}
const bob: BotRequestAsker = { ...alice, userId: 'acct-bob' }
const linked = (source: 'slack' | 'github'): BotRequestAsker => ({
  ...alice,
  source,
  userId: 'U-alice',
  viaAccount: 'acct-alice'
})

const chat = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ids = {
  alicesChat: chat(1),
  alicesSlackChat: chat(2),
  alicesGitHubThread: chat(3),
  ownersChat: chat(4),
  mixedChat: chat(5),
  bobsChat: chat(6),
  unrecordedChat: chat(7),
  alicesOtherBotChat: chat(8)
}
const SESSIONS: { id: string; bot: typeof SHARED; actsFor: BotRequestAsker[] | null }[] = [
  { id: ids.alicesChat, bot: SHARED, actsFor: [alice] },
  { id: ids.alicesSlackChat, bot: SHARED, actsFor: [linked('slack')] },
  { id: ids.alicesGitHubThread, bot: SHARED, actsFor: [linked('github')] },
  { id: ids.ownersChat, bot: SHARED, actsFor: [...OWNER_ACTS_FOR] },
  { id: ids.mixedChat, bot: SHARED, actsFor: [alice, bob] },
  { id: ids.bobsChat, bot: SHARED, actsFor: [bob] },
  { id: ids.unrecordedChat, bot: SHARED, actsFor: null },
  { id: ids.alicesOtherBotChat, bot: OTHER, actsFor: [alice] }
]

const envelope = (sessionId: string) => ({
  sessionId,
  clientOperationId: 'op-1',
  expectedRuntimeFence: 1,
  payloadFingerprint: 'a'.repeat(64)
})

let directory: string
let db: OrchestrationDb
let dispatcher: RpcDispatcher
let runtime: OrcaRuntimeService
let homes: { shared: string; other: string }

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bot-share-admission-'))
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
  runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'getOrchestrationDb').mockReturnValue(db)
  // The guard opens the chat host first; this one is already installed below.
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockRejectedValue(new Error('installed'))
  const linkedBot = (bot: typeof SHARED): Bot =>
    makeTestBot({
      ...bot,
      slack: { appId: 'A-SECRET', teamId: 'T-SECRET', ownerUserId: 'U-OWNER' },
      chatSessionId: ids.ownersChat,
      // Alice's share row: the name a teammate's actions are recorded by.
      ...(bot.id === SHARED.id
        ? {
            shares: [
              {
                kind: 'account' as const,
                shareId: 'share-alice',
                accountId: SCOPE.accountId,
                name: 'Alice',
                email: 'alice@example.com',
                addedAt: 1,
                acceptedAt: 2
              }
            ]
          }
        : {})
    })
  vi.spyOn(runtime, 'restoreStructuredAgentSessionTabs').mockResolvedValue(undefined)
  vi.spyOn(runtime.bots, 'list').mockReturnValue([linkedBot(SHARED), linkedBot(OTHER)])
  // The shared bot's home, a file outside it, and a symlink in the home that points out.
  homes = { shared: join(directory, 'home-shared'), other: join(directory, 'home-other') }
  mkdirSync(join(homes.shared, 'notes'), { recursive: true })
  writeFileSync(join(homes.shared, 'notes', 'a.md'), 'a')
  mkdirSync(homes.other)
  writeFileSync(join(homes.other, 'secret.md'), 'secret')
  symlinkSync(homes.other, join(homes.shared, 'escape'), 'junction')
  const homeOf = new Map<string, string>([
    [folderWorkspaceKey(SHARED.folderWorkspaceId), homes.shared],
    [folderWorkspaceKey(OTHER.folderWorkspaceId), homes.other]
  ])
  vi.spyOn(runtime, 'resolveRuntimeFileTarget').mockImplementation(async (selector) => {
    const path = homeOf.get(selector.replace(/^id:/, ''))
    if (!path) {
      throw new Error('selector_not_found')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard reads only the folder's path and host.
    return { worktree: { path }, executionHostId: 'local' } as Awaited<
      ReturnType<OrcaRuntimeService['resolveRuntimeFileTarget']>
    >
  })
  // What the owner's roster holds: where each bot is linked and what its SOUL.md says.
  vi.spyOn(runtime.bots, 'roster').mockResolvedValue(
    [SHARED, OTHER].map((bot) => ({
      id: bot.id,
      name: bot.id,
      agent: 'claude',
      paused: false,
      specialty: 'SECRET specialty',
      linked: ['Slack workspace T-SECRET']
    }))
  )
  const workspaceOf = new Map<string, string>()
  for (const { id, bot, actsFor } of SESSIONS) {
    workspaceOf.set(id, folderWorkspaceKey(bot.folderWorkspaceId))
    if (actsFor) {
      db.recordBotConversationActsFor(id, { actsFor })
    }
  }
  setStructuredAgentSessionHost(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard reads only records' workspaces and the lineage list.
    {
      deps: {
        store: {
          listConversations: () => [],
          getConversation: (id: string) =>
            workspaceOf.has(id) ? { location: { workspaceId: workspaceOf.get(id) } } : null
        }
      },
      // Every chat on the host, as the owner's own stream carries them.
      subscribeStatus: ({ emit }: { emit: (event: unknown) => void }) => {
        const summary = (sessionId: string) => ({ sessionId, agent: 'claude' })
        emit({
          type: 'snapshot',
          sessions: SESSIONS.map(({ id }) => summary(id)),
          conversationNames: SESSIONS.map(({ id }) => ({ sessionId: id, conversationName: id })),
          namingActiveSessionIds: SESSIONS.map(({ id }) => id)
        })
        for (const { id } of SESSIONS) {
          emit({ type: 'status', session: summary(id) })
        }
        return () => {}
      }
    } as unknown as StructuredAgentSessionHost
  )
  // Real names and param schemas, handlers that only say they ran: the guard runs before them.
  const ran = () => ({ ran: true })
  dispatcher = new RpcDispatcher({
    runtime,
    methods: [
      defineMethod({
        name: 'agentSession.history',
        permission: 'workspace',
        share: SHARE_BY_SESSION,
        params: HistoryParams,
        handler: ran
      }),
      defineMethod({
        name: 'agentSession.respondToApproval',
        permission: 'workspace',
        share: SHARE_BY_ENVELOPE_SESSION,
        params: RespondParams,
        handler: ran
      }),
      defineMethod({
        name: 'bots.chats',
        permission: 'workspace',
        share: SHARE_BY_BOT,
        params: BotChats,
        handler: ran
      }),
      defineMethod({
        name: 'agentSessionAttachment.uploadStart',
        permission: 'workspace',
        share: SHARE_BY_SESSION,
        params: AttachmentUploadStartParams,
        handler: ran
      }),
      defineMethod({
        name: 'agentSessionAttachment.read',
        permission: 'workspace',
        share: SHARE_BY_ATTACHMENT,
        params: AttachmentReadParams,
        handler: ran
      }),
      defineMethod({
        name: 'files.readDir',
        permission: 'workspace',
        share: SHARE_BY_BOT_FOLDER,
        params: FileDirRead,
        // Answers with the params it ran with, as the read would use them.
        handler: (params) => params
      }),
      defineMethod({
        name: 'files.stat',
        permission: 'workspace',
        share: SHARE_BY_BOT_FOLDER,
        params: FileTreePath,
        // A part of the path swapped for a symlink out while the read runs.
        handler: confinedFolderRead(async () => {
          renameSync(join(homes.shared, 'notes'), join(homes.shared, 'notes-moved'))
          symlinkSync(homes.other, join(homes.shared, 'notes'), 'junction')
          return { ran: true }
        })
      }),
      defineMethod({
        name: 'files.read',
        permission: 'workspace',
        share: SHARE_BY_BOT_FOLDER,
        params: FileOpen,
        handler: ran
      }),
      defineMethod({
        name: 'bots.slack.state',
        permission: 'accounts-admin',
        share: SHARE_BY_BOT,
        params: BotSlackBot,
        handler: ran
      }),
      defineMethod({
        name: 'bots.slack.setUpApp',
        permission: 'accounts-admin',
        share: 'not-shared',
        params: BotSlackSetUp,
        handler: ran
      }),
      defineMethod({
        name: 'bots.chats.seen',
        permission: 'workspace',
        share: 'not-shared',
        params: null,
        handler: ran
      }),
      ...BOT_METHODS.filter((method) => method.name === 'bots.roster'),
      ...BOT_ITEMS_OWNER_METHODS,
      ...BOT_METHODS.filter((method) => method.name === 'bots.list'),
      // Their real share decisions: every call below is refused before its handler.
      ...STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS.filter((method) =>
        MODEL_PICKER_METHODS.has(method.name)
      ),
      ...STRUCTURED_AGENT_SESSION_PROMPT_RESPONSE_METHODS.filter((method) =>
        MODEL_PICKER_METHODS.has(method.name)
      ),
      ...STRUCTURED_AGENT_SESSION_STATUS_METHODS,
      ...STATUS_METHODS
    ]
  })
})

afterEach(() => {
  setAgentSessionAttachmentStore(null)
  setStructuredAgentSessionHost(null)
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

const MODEL_PICKER_METHODS = new Set([
  'agentSession.modelCatalog',
  'agentSession.options',
  'agentSession.setOption'
])

async function call(method: string, params: unknown) {
  return await dispatcher.dispatch(
    { id: 'r1', authToken: '', method, params },
    { callerScope: SCOPE, pairedDeviceId: 'share-device', clientKind: 'runtime' }
  )
}

const Session = z.object({ sessionId: z.string() })
const StatusEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot'),
    sessions: z.array(Session),
    conversationNames: z.array(Session),
    namingActiveSessionIds: z.array(z.string())
  }),
  z.object({ type: z.literal('status'), session: Session })
])

async function streamStatus(): Promise<string[]> {
  const streamed: string[] = []
  await dispatcher.dispatchStreamingObjects(
    { id: 'r1', authToken: '', method: 'agentSession.subscribeStatus', params: undefined },
    (response) => {
      if (response.ok && response.streaming) {
        const event = StatusEvent.parse(response.result)
        streamed.push(
          ...(event.type === 'snapshot'
            ? [
                ...event.sessions.map((session) => `snapshot:${session.sessionId}`),
                ...event.conversationNames.map((note) => `name:${note.sessionId}`),
                ...event.namingActiveSessionIds.map((sessionId) => `naming:${sessionId}`)
              ]
            : [`status:${event.session.sessionId}`])
        )
      }
    },
    {
      callerScope: SCOPE,
      pairedDeviceId: 'share-device',
      clientKind: 'runtime',
      clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
      connectionId: 'share-connection'
    }
  )
  return streamed
}

const errorCode = (response: Awaited<ReturnType<typeof call>>) =>
  response.ok ? null : response.error.code

describe('the share guard', () => {
  it('lists a teammate their own items by default and everyone’s when they ask, on the shared bot only', async () => {
    const store = BotItemsStore.open(':memory:')
    try {
      const add = (botId: string, title: string, actsForAccounts: string[] | null): string =>
        store.add(
          {
            ownerBotId: botId,
            chatId: ids.alicesChat,
            source: { kind: 'home', title: null },
            actsForAccounts,
            title,
            status: 'working',
            links: []
          },
          { kind: 'bot', botId, chatId: ids.alicesChat }
        ).uid
      add(SHARED.id, 'Alice’s', ['acct-alice'])
      const ownersUid = add(SHARED.id, 'The owner’s', null)
      add(SHARED.id, 'Bob’s', ['acct-bob'])
      const otherBotsUid = add(OTHER.id, 'Another bot’s', ['acct-alice'])
      vi.spyOn(runtime.bots, 'assertEnabled').mockReturnValue(undefined)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list and show handlers read only these two
      vi.spyOn(runtime, 'botItems', 'get').mockReturnValue({
        store: () => store,
        views: async (records: readonly BotItemRecord[]) =>
          records.map((record) => ({
            uid: record.uid,
            title: record.title,
            status: record.status
          })),
        events: async () => [],
        changed: () => {},
        sendOwedMail: async () => {}
      } as never)
      const titles = async (params: Record<string, unknown>) => {
        const response = await call('bots.items.owner.list', params)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list's answer
        const result = (response.ok ? response.result : null) as {
          items: { title: string }[]
        } | null
        return result?.items.map((item) => item.title).sort() ?? null
      }
      expect(await titles({ botId: SHARED.id })).toEqual(['Alice’s'])
      expect(await titles({ botId: SHARED.id, everyone: true })).toEqual([
        'Alice’s',
        'Bob’s',
        'The owner’s'
      ])
      expect(await titles({ botId: SHARED.id, person: 'acct-bob' })).toEqual(['Bob’s'])
      expect(errorCode(await call('bots.items.owner.list', { botId: OTHER.id }))).toBe('not_found')
      // Any of the shared bot's items opens by number or uid; another bot's does not.
      expect(
        errorCode(await call('bots.items.owner.show', { botId: SHARED.id, item: ownersUid }))
      ).toBeNull()
      expect(
        errorCode(await call('bots.items.owner.show', { botId: SHARED.id, item: otherBotsUid }))
      ).toBe('not_found')
      // She acts on any of its items as the owner does, as herself.
      expect(
        errorCode(
          await call('bots.items.owner.comment', {
            botId: SHARED.id,
            item: ownersUid,
            text: 'On it'
          })
        )
      ).toBeNull()
      expect(store.events(ownersUid, 0, 50).at(-1)?.actor).toEqual({
        kind: 'owner',
        device: 'share-device',
        person: { accountId: 'acct-alice', name: 'Alice' }
      })
      expect(
        errorCode(
          await call('bots.items.owner.status', {
            botId: SHARED.id,
            items: [otherBotsUid],
            status: 'done',
            note: 'x'
          })
        )
      ).toBe('not_found')
      // Her seen mark is her own; the owner's stays.
      const update = vi.spyOn(runtime.bots, 'update').mockImplementation(async (_id, change) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mark's update is a function of the bot
        const next = (change as (bot: Bot) => Partial<Bot>)(makeTestBot(SHARED))
        return { ...makeTestBot(SHARED), ...next }
      })
      expect(errorCode(await call('bots.items.owner.opened', { botId: SHARED.id }))).toBeNull()
      const written = await update.mock.results[0]?.value
      expect(written?.itemsSeenBy?.['acct-alice']).toBeGreaterThan(0)
      expect(written?.itemsSeen).toBeUndefined()
    } finally {
      store.dispose()
    }
  })

  it('lists her the shared agent’s people, with her as the one looking, for the Items filter', async () => {
    const share = (accountId: string, name: string) => ({
      kind: 'account' as const,
      shareId: `s-${accountId}`,
      accountId,
      name,
      email: `${accountId}@example.com`,
      addedAt: 1,
      acceptedAt: 2
    })
    const shared = makeTestBot({
      ...SHARED,
      shares: [share('acct-alice', 'Alice'), share('acct-bob', 'Bob')]
    })
    const listing = { bots: [shared], botsEnabled: true }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the share branch of bots.list reads only bots and botsEnabled
    vi.spyOn(runtime.bots, 'listing').mockReturnValue(listing as never)
    const response = await call('bots.list', undefined)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list's answer
    const listed = (response.ok ? response.result : null) as { bots: Bot[] } | null
    const entries = botPeoplePicker(listed!.bots[0]!, null)
    expect(entries?.map((entry) => `${entry.pick.kind}:${entry.name}`)).toEqual([
      'person:Alice',
      'owner:null',
      'person:Bob'
    ])
    expect(listed!.bots[0]!.shares).toBeUndefined()
  })

  // A trusted teammate reaches every chat of the shared bot, whoever it is for; never another bot's.
  it('admits reads and actions in every chat of the shared bot, and none of another bot', async () => {
    const history = (sessionId: string) =>
      call('agentSession.history', { sessionId, direction: 'tail' })
    const approve = (sessionId: string) =>
      call('agentSession.respondToApproval', {
        envelope: envelope(sessionId),
        itemId: 'item-1',
        expectedRevision: 1,
        optionId: 'allow'
      })
    for (const reached of [
      ids.alicesChat,
      ids.alicesSlackChat,
      ids.alicesGitHubThread,
      ids.ownersChat,
      ids.mixedChat,
      ids.bobsChat,
      ids.unrecordedChat
    ]) {
      expect(errorCode(await history(reached))).toBeNull()
      expect(errorCode(await approve(reached))).toBeNull()
    }
    expect(errorCode(await history(ids.alicesOtherBotChat))).toBe('not_found')
    expect(errorCode(await approve(ids.alicesOtherBotChat))).toBe('not_found')
  })

  it('reads and sets the model only on a chat of the shared bot, never the host’s catalog without one', async () => {
    expect(errorCode(await call('agentSession.modelCatalog', { agent: 'claude' }))).toBe(
      'not_found'
    )
    for (const refused of [ids.alicesOtherBotChat]) {
      expect(
        errorCode(await call('agentSession.modelCatalog', { agent: 'claude', sessionId: refused }))
      ).toBe('not_found')
      expect(errorCode(await call('agentSession.options', { sessionId: refused }))).toBe(
        'not_found'
      )
      expect(
        errorCode(
          await call('agentSession.setOption', {
            envelope: envelope(refused),
            key: 'model',
            value: 'opus'
          })
        )
      ).toBe('not_found')
    }
  })

  it('reads only inside the shared bot’s home folder, never through .. or a symlink out', async () => {
    // As the Files panel names it.
    const home = `id:${folderWorkspaceKey(SHARED.folderWorkspaceId)}`
    const readDir = (worktree: string, relativePath: string, followSymlinks?: boolean) =>
      call('files.readDir', {
        worktree,
        relativePath,
        ...(followSymlinks ? { followSymlinks } : {})
      })
    const read = (relativePath: string) => call('files.read', { worktree: home, relativePath })
    expect(errorCode(await readDir(home, ''))).toBeNull()
    expect(errorCode(await readDir(home, 'notes'))).toBeNull()
    expect(errorCode(await read('notes/a.md'))).toBeNull()
    for (const escape of [
      '../home-other/secret.md',
      'notes/../../home-other/secret.md',
      join(homes.other, 'secret.md'),
      join(homes.shared, 'notes', 'a.md'),
      'escape/secret.md',
      'missing.md'
    ]) {
      expect(errorCode(await read(escape))).toBe('not_found')
    }
    expect(errorCode(await readDir(home, 'escape'))).toBe('not_found')
    // The read runs with symlinks off whatever is asked or left to the host's setting, so a symlink
    // out of the folder (escape) is listed by name and never followed; its path is the resolved one.
    for (const followSymlinks of [undefined, true]) {
      const listed = await readDir(home, '', followSymlinks)
      expect(listed.ok ? listed.result : null).toMatchObject({
        relativePath: '',
        followSymlinks: false
      })
    }
    symlinkSync(join(homes.shared, 'notes'), join(homes.shared, 'inner'), 'junction')
    const viaLink = await readDir(home, 'inner')
    expect(viaLink.ok ? viaLink.result : null).toMatchObject({
      relativePath: 'notes',
      followSymlinks: false
    })
    // Another bot's home, and a spelling of a selector other than the home's own.
    expect(errorCode(await readDir(folderWorkspaceKey(OTHER.folderWorkspaceId), ''))).toBe(
      'not_found'
    )
    expect(errorCode(await readDir(`path:${homes.shared}`, ''))).toBe('not_found')
  })

  it('answers nothing for a read whose path was swapped for a symlink out while it ran', async () => {
    const home = `id:${folderWorkspaceKey(SHARED.folderWorkspaceId)}`
    expect(
      errorCode(await call('files.stat', { worktree: home, relativePath: 'notes/a.md' }))
    ).not.toBeNull()
  })

  it('ends a teammate’s watch once its folder is moved, and passes nothing after', async () => {
    const forwarded: unknown[] = []
    const watch = await confinedFolderWatch(
      { worktree: `id:${folderWorkspaceKey(SHARED.folderWorkspaceId)}` },
      { runtime, callerScope: SCOPE },
      (event) => forwarded.push(event)
    )
    watch.emit('before')
    await vi.waitFor(() => expect(forwarded).toEqual(['before']))
    renameSync(homes.shared, `${homes.shared}-moved`)
    mkdirSync(homes.shared)
    watch.emit('after')
    await vi.waitFor(() => expect(watch.signal?.aborted).toBe(true))
    expect(forwarded).toEqual(['before'])
  })

  it('reads the shared bot’s connectors only, and none of their setup', async () => {
    expect(errorCode(await call('bots.slack.state', { botId: SHARED.id }))).toBeNull()
    expect(errorCode(await call('bots.slack.state', { botId: OTHER.id }))).toBe('not_found')
    expect(errorCode(await call('bots.slack.state', {}))).not.toBeNull()
    expect(errorCode(await call('bots.slack.setUpApp', { botId: SHARED.id, teamId: 'T1' }))).toBe(
      'forbidden'
    )
  })

  it('stages an upload for any chat of the shared bot, so it can’t probe another bot’s', async () => {
    const upload = (sessionId: string) =>
      call('agentSessionAttachment.uploadStart', { sessionId, name: 'a.txt', byteLength: 1 })
    expect(errorCode(await upload(ids.alicesChat))).toBeNull()
    expect(errorCode(await upload(ids.ownersChat))).toBeNull()
    expect(errorCode(await upload(ids.alicesOtherBotChat))).toBe('not_found')
  })

  // A stored file's upload id is claimed by the chats whose messages carry it (the journal's claims).
  it('previews a stored attachment only when a chat of the shared bot claims it, right after a restart too', async () => {
    const root = join(directory, 'attachments')
    const theirs = join(root, '11111111-1111-4111-8111-111111111111', 'a.png')
    const owners = join(root, '22222222-2222-4222-8222-222222222222', 'b.png')
    const otherBots = join(root, '33333333-3333-4333-8333-333333333333', 'c.png')
    const claims = new Map([
      ['11111111-1111-4111-8111-111111111111', [ids.alicesChat]],
      ['22222222-2222-4222-8222-222222222222', [ids.ownersChat]],
      ['33333333-3333-4333-8333-333333333333', [ids.alicesOtherBotChat]]
    ])
    // As on a cold start: the store comes with the chat host, which the first call opens.
    vi.mocked(runtime.ensureStructuredAgentSessionHost).mockImplementation(async () => {
      setAgentSessionAttachmentStore(
        new AgentSessionAttachmentStore(root, {
          hasSession: () => true,
          claimingSessions: async (uploadId) => claims.get(uploadId) ?? []
        }),
        async () => {}
      )
      throw new Error('installed')
    })
    const read = (path: string) => call('agentSessionAttachment.read', { path })
    expect(errorCode(await read(theirs))).toBeNull()
    expect(errorCode(await read(owners))).toBeNull()
    expect(errorCode(await read(otherBots))).toBe('not_found')
    expect(errorCode(await read(join(directory, 'elsewhere.png')))).toBe('not_found')
  })

  // A composer chip's thumbnail reads the file back before any message claims it.
  it('previews an unsent upload to a chat of the shared bot, and none to another bot’s', async () => {
    const store = new AgentSessionAttachmentStore(join(directory, 'attachments'), {
      hasSession: () => true,
      claimingSessions: async () => []
    })
    setAgentSessionAttachmentStore(store, async () => {})
    const stored = async (sessionId: string): Promise<string> => {
      const callerKey = 'caller'
      const { uploadId } = await store.startUpload({
        callerKey,
        sessionId,
        name: 'a.png',
        byteLength: 1
      })
      await store.appendChunk({ callerKey, uploadId, offset: 0, contentBase64: 'AA==' })
      return (await store.commitUpload({ callerKey, uploadId })).path
    }
    const read = (path: string) => call('agentSessionAttachment.read', { path })
    expect(errorCode(await read(await stored(ids.alicesChat)))).toBeNull()
    expect(errorCode(await read(await stored(ids.bobsChat)))).toBeNull()
    expect(errorCode(await read(await stored(ids.alicesOtherBotChat)))).toBe('not_found')
  })

  it('lets New chat reopen only an empty chat of the asker’s own', () => {
    const forOwner = emptyChatReusableBy(runtime, null)
    const forAlice = emptyChatReusableBy(runtime, SCOPE)
    expect([ids.ownersChat, ids.unrecordedChat].filter(forOwner)).toHaveLength(2)
    expect([ids.alicesChat, ids.mixedChat, ids.bobsChat].some(forOwner)).toBe(false)
    expect(forAlice(ids.alicesChat)).toBe(true)
    expect([ids.ownersChat, ids.unrecordedChat, ids.bobsChat].some(forAlice)).toBe(false)
  })

  it('refuses a call naming another bot, and every method off the share list', async () => {
    expect(errorCode(await call('bots.chats', { botId: SHARED.id }))).toBeNull()
    expect(errorCode(await call('bots.chats', { botId: OTHER.id }))).toBe('not_found')
    expect(errorCode(await call('bots.chats', {}))).toBe('not_found')
    expect(errorCode(await call('bots.chats.seen', undefined))).toBe('forbidden')
  })

  it('streams a teammate the status of every chat of the shared bot alone', async () => {
    const theirs = SESSIONS.filter((session) => session.bot === SHARED).map((session) => session.id)
    expect(await streamStatus()).toEqual([
      ...theirs.map((id) => `snapshot:${id}`),
      ...theirs.map((id) => `name:${id}`),
      ...theirs.map((id) => `naming:${id}`),
      ...theirs.map((id) => `status:${id}`)
    ])
  })

  it('gives a teammate the shared bot’s roster line without where it is linked or its SOUL.md', async () => {
    const response = await call('bots.roster', {})
    expect(response.ok && response.result).toEqual({
      bots: [
        {
          id: SHARED.id,
          name: 'Reviewer',
          agent: 'codex',
          paused: false,
          specialty: null,
          linked: []
        }
      ]
    })
  })

  it('answers a teammate’s status with its protocol and capabilities, nothing of this computer', async () => {
    const response = await call('status.get', undefined)
    const status: object | null = response.ok ? Object(response.result) : null
    expect(status).toMatchObject({
      runtimeId: runtime.getRuntimeId(),
      capabilities: runtime.getStatus().capabilities,
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0
    })
    const shared = new Set([
      'runtimeId',
      'rendererGraphEpoch',
      'graphStatus',
      'authoritativeWindowId',
      'liveTabCount',
      'liveLeafCount',
      'runtimeProtocolVersion',
      'minCompatibleRuntimeClientVersion',
      'capabilities',
      'appVersion',
      'protocolVersion',
      'minCompatibleMobileVersion'
    ])
    expect(Object.keys(status ?? {}).filter((key) => !shared.has(key))).toEqual([])
  })

  // The whole share surface, read off each method's own decision: a change here is a security review.
  it('shares exactly these methods, each scoped one with its view', () => {
    expect(botShareMethodNames().sort()).toEqual(
      [
        'agentSession.cancel',
        'agentSession.currentRequests',
        'agentSession.history',
        'agentSession.item',
        'agentSession.liveTextShown',
        'agentSession.modelCatalog',
        'agentSession.options',
        'agentSession.queuedMessageDelete',
        'agentSession.queuedMessageEditHold',
        'agentSession.queuedMessageMove',
        'agentSession.queuedMessageSend',
        'agentSession.queuedMessageUpdate',
        'agentSession.queuedMessagesResume',
        'agentSession.readVisual',
        'agentSession.respondToApproval',
        'agentSession.respondToQuestion',
        'agentSession.send',
        'agentSession.setOption',
        'agentSession.subscribe',
        'agentSession.subscribeStatus',
        'agentSession.unsubscribe',
        'agentSessionAttachment.read',
        'agentSessionAttachment.readTextChunk',
        'agentSessionAttachment.uploadAbort',
        'agentSessionAttachment.uploadAppend',
        'agentSessionAttachment.uploadCommit',
        'agentSessionAttachment.uploadStart',
        'bots.agentChoices',
        'bots.avatar.read',
        'bots.chat.open',
        'bots.chat.reset',
        'bots.chatTree',
        'bots.chats',
        'bots.chats.own',
        'bots.chats.search',
        'bots.items.owner.comment',
        'bots.items.owner.list',
        'bots.items.owner.opened',
        'bots.items.owner.show',
        'bots.items.owner.snooze',
        'bots.items.owner.status',
        'bots.list',
        'bots.roster',
        'bots.session.start',
        'botShare.provisionPhone',
        'botShare.revokePhone',
        'pairing.getEndpoints',
        'pairing.provisionRelay',
        'status.get',
        'bots.activity',
        'bots.composio.status',
        'bots.github.state',
        'bots.linear.state',
        'bots.slack.state',
        'bots.tools.list',
        'files.list',
        'files.read',
        'files.readChunk',
        'files.readDir',
        'files.readPreview',
        'files.searchPaths',
        'files.stat',
        'files.watch',
        'google.status'
      ].sort()
    )
    const scoped = ALL_RPC_METHODS.filter(
      (method) => method.share !== 'not-shared' && method.share.kind === 'scoped'
    ).map((method) => method.name)
    expect(scoped.sort()).toEqual([...BOT_SHARE_SCOPED_METHODS].sort())
  })
})
