import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { OWNER_ACTS_FOR, type BotRequestAsker } from '../../../../shared/bots/bot-acts-for'
import { BotChats } from '../../../../shared/rpc-contract/bots-params'
import { AttachmentUploadStartParams } from '../../../../shared/rpc-contract/structured-agent-session/agent-session-attachment-params'
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
import { BOT_SHARE_RPC_METHODS } from '../../../../shared/bots/bot-share-rpc-methods'
import { defineMethod } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { ALL_RPC_METHODS } from '../methods/rpc-method-registry'

const SHARED = { id: 'bot-shared', folderWorkspaceId: 'home-shared' }
const OTHER = { id: 'bot-other', folderWorkspaceId: 'home-other' }
const SCOPE: BotShareCallerScope = {
  kind: 'bot-share',
  botId: SHARED.id,
  accountId: 'acct-alice',
  name: 'Alice'
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

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bot-share-admission-'))
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
  runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'getOrchestrationDb').mockReturnValue(db)
  // The guard opens the chat host first; this one is already installed below.
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockRejectedValue(new Error('installed'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard reads only a bot's id and home folder.
  vi.spyOn(runtime.bots, 'list').mockReturnValue([SHARED, OTHER] as Bot[])
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
        params: HistoryParams,
        handler: ran
      }),
      defineMethod({
        name: 'agentSession.respondToApproval',
        permission: 'workspace',
        params: RespondParams,
        handler: ran
      }),
      defineMethod({ name: 'bots.chats', permission: 'workspace', params: BotChats, handler: ran }),
      defineMethod({
        name: 'agentSessionAttachment.uploadStart',
        permission: 'workspace',
        params: AttachmentUploadStartParams,
        handler: ran
      }),
      defineMethod({ name: 'bots.chats.seen', permission: 'workspace', params: null, handler: ran })
    ]
  })
})

afterEach(() => {
  setStructuredAgentSessionHost(null)
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

async function call(method: string, params: unknown) {
  return await dispatcher.dispatch(
    { id: 'r1', authToken: '', method, params },
    { callerScope: SCOPE, pairedDeviceId: 'share-device', clientKind: 'runtime' }
  )
}

const errorCode = (response: Awaited<ReturnType<typeof call>>) =>
  response.ok ? null : response.error.code

describe('the share guard', () => {
  it('admits reads and actions only in the teammate’s own chats on the shared bot', async () => {
    const history = (sessionId: string) =>
      call('agentSession.history', { sessionId, direction: 'tail' })
    const approve = (sessionId: string) =>
      call('agentSession.respondToApproval', {
        envelope: envelope(sessionId),
        itemId: 'item-1',
        expectedRevision: 1,
        optionId: 'allow'
      })
    for (const theirs of [ids.alicesChat, ids.alicesSlackChat]) {
      expect(errorCode(await history(theirs))).toBeNull()
      expect(errorCode(await approve(theirs))).toBeNull()
    }
    for (const refused of [
      ids.alicesGitHubThread,
      ids.ownersChat,
      ids.mixedChat,
      ids.bobsChat,
      ids.unrecordedChat,
      ids.alicesOtherBotChat
    ]) {
      expect(errorCode(await history(refused))).toBe('not_found')
      expect(errorCode(await approve(refused))).toBe('not_found')
    }
  })

  it('stages an upload only for the teammate’s own chat, so it can’t probe other chats', async () => {
    const upload = (sessionId: string) =>
      call('agentSessionAttachment.uploadStart', { sessionId, name: 'a.txt', byteLength: 1 })
    expect(errorCode(await upload(ids.alicesChat))).toBeNull()
    expect(errorCode(await upload(ids.ownersChat))).toBe('not_found')
    expect(errorCode(await upload(ids.alicesOtherBotChat))).toBe('not_found')
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

  it('lists only methods this host serves', () => {
    const served = new Set<string>(ALL_RPC_METHODS.map((method) => method.name))
    expect([...BOT_SHARE_RPC_METHODS.keys()].filter((name) => !served.has(name))).toEqual([])
  })
})
