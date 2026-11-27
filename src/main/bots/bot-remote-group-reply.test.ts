// @orca-isolated-worker
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import type * as BotChatSession from './bot-chat-session'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { agentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import {
  PeerMailDeliverParams,
  PeerMailRelayPayload
} from '../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { BotGroupRuntime, botMailOwner } from './bot-group-runtime'
import { deliverRemoteAsks } from './bot-group-remote'
import { remoteRoomMailArrived } from './bot-group-remote-answers'
import { remoteGroupJournal } from './bot-remote-group-journal.test-fixture'
import { makeTestBot } from './bot.test-fixture'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { deliverPeerMailToBot } from '../runtime/rpc/methods/orchestration/federation/peer-mail-bot-delivery'
import { botQuestionNotices } from '../runtime/rpc/methods/orchestration/messaging/bot-question-notices'
import { replyOverPeerMail } from '../runtime/rpc/methods/orchestration/messaging/peer-mail-reply'
import { reconcileQuestions } from '../runtime/orchestration/mailbox/questions/question-reconcile'
import { storePeerReply } from '../runtime/orchestration/federation/peer-mail/peer-reply-store'
import { botChatRecordRow } from '../runtime/rpc/methods/bots-chats'
import { generateId } from '../runtime/orchestration/db/generated-id'
import { ORCHESTRATION_PEER_GROUP_MAIL_RUNTIME_CAPABILITY } from '../../shared/orchestration/orchestration-runtime-capabilities'
import { projectStructuredAiVaultSessions } from '../ai-vault/structured-sessions/structured-session-ownership'
import {
  codexChatHolding,
  historySession,
  installChats,
  listResult
} from '../ai-vault/structured-sessions/structured-session-ownership.test-support'

const launch = vi.hoisted(() => ({ create: async (_id: string) => '' }))
vi.mock('./bot-chat-session', async (original) => {
  const actual = await original<typeof BotChatSession>()
  return {
    ...actual,
    startBotSession: (...args: Parameters<typeof actual.startBotSession>) =>
      launch.create(args[2]!.sessionId!)
  }
})

const HOME = '11111111-1111-4111-8111-111111111111'
const bot = makeTestBot({ id: 'helper', name: 'Helper', chatSessionId: HOME })
const idle = {
  running: () => false,
  mailboxes: () => [],
  handingOver: () => false,
  dispatchParty: () => null
}
let directory: string
let a: OrcaRuntimeService
let b: OrcaRuntimeService
let aDb: OrchestrationDb
let bDb: OrchestrationDb
let groups: BotGroupRuntime
const records = new Map<string, ReturnType<typeof agentSessionConversationView>>()
const journals = new Map<string, ReturnType<typeof remoteGroupJournal>>()

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'orca-remote-group-reply-'))
  aDb = new OrchestrationDb(':memory:')
  bDb = new OrchestrationDb(':memory:')
  a = new OrcaRuntimeService(null)
  b = new OrcaRuntimeService(null)
  a.setOrchestrationDb(aDb)
  b.setOrchestrationDb(bDb)
  for (const runtime of [a, b]) {
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
    vi.spyOn(runtime, 'ensureOrchestrationPeerMailRelay').mockImplementation(() => {})
    vi.spyOn(runtime, 'readMachineName').mockReturnValue('Test host')
  }
  vi.spyOn(b.bots, 'list').mockReturnValue([bot])
  vi.spyOn(b.bots, 'enabled').mockReturnValue(true)
  launch.create = async (sessionId) => {
    const record = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
    records.set(
      sessionId,
      agentSessionConversationView({
        ...record,
        provider: 'codex',
        location: { ...record.location, workspaceId: folderWorkspaceKey(bot.folderWorkspaceId) }
      })
    )
    journals.set(sessionId, remoteGroupJournal(directory, sessionId))
    return sessionId
  }
  await launch.create(HOME)
  const host = {
    deps: {
      store: {
        getConversation: (id: string) => records.get(id) ?? null,
        listConversations: () => [...records.values()],
        getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [HOME] }),
        isSessionInBackground: (id: string) => id !== HOME
      }
    },
    journalReads: async (id: string) => journals.get(id)!.reads,
    conversation: async () => ({ journal: { queuedMessages: { failureHolds: async () => false } } })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only provider launch and host storage are substituted; admission, attribution, reconciliation and relay storage are real.
  setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
  vi.spyOn(a, 'resolveOrchestrationWorkerServer').mockResolvedValue({
    environmentId: 'peer',
    name: 'Peer',
    peerFingerprint: 'pairing'
  })
  vi.spyOn(a, 'callOrchestrationWorkerServer').mockImplementation(
    async (_selector, method, params) => {
      if (method === 'status.get') {
        return b.getStatus()
      }
      await deliverPeerMailToBot(b, PeerMailDeliverParams.parse(params), 'pairing', undefined)
      return {}
    }
  )
  groups = new BotGroupRuntime(a)
  for (const id of ['origin', 'other']) {
    groups.store.put({
      id,
      name: id,
      hostId: 'local',
      revision: 1,
      folder: id,
      folderWorkspaceId: id,
      createdAt: 1,
      members: [],
      replyMode: { kind: 'mentions' }
    })
  }
})

afterEach(async () => {
  await Promise.resolve()
  setStructuredAgentSessionHost(null)
  for (const journal of journals.values()) {
    journal.close()
  }
  journals.clear()
  records.clear()
  aDb.close()
  bDb.close()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

async function queueMention(groupId = 'origin', threadId?: string) {
  const requestId = generateId('msg')
  const post = groups.store.append({
    id: generateId('msg'),
    groupId,
    ...(threadId ? { threadId } : {}),
    author: { kind: 'owner' },
    text: '@Helper status?',
    createdAt: 2,
    turns: [],
    remoteAsks: [
      {
        environmentId: 'peer',
        computer: 'Peer',
        botId: bot.id,
        name: bot.name,
        avatar: null,
        agent: 'codex',
        chatSessionId: HOME,
        joinedAfter: 0,
        requestId,
        state: 'sending'
      }
    ]
  })
  await deliverRemoteAsks(groups, post, new Map([[requestId, 'Report the build status.']]))
  return { requestId, post }
}

async function mention(groupId = 'origin', threadId?: string) {
  const { requestId, post } = await queueMention(groupId, threadId)
  const request = bDb.getMessageById(requestId)!
  expect(request).toBeDefined()
  const sessionId = request.to_handle.slice('orca_session_id:'.length)
  expect(sessionId).not.toBe(HOME)
  const operationId = `mail-${requestId}`
  const body = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: request.body }],
    from: {
      kind: 'agent' as const,
      senders: [],
      orchestration: {
        message: 'mail-notice' as const,
        mailbox: request.to_handle,
        dispatchId: null,
        messages: [{ messageId: requestId, runId: '', from: request.from_handle }]
      }
    }
  }
  botMailOwner(b).beforeSend({
    sessionId,
    operationId,
    dispatchId: null,
    expectedRuntimeFence: 1,
    body,
    stillOwed: () => true
  })
  journals.get(sessionId)!.send(operationId, body, requestId)
  bDb.markAsRead([requestId], { kind: 'session', sessionId })
  return { requestId, sessionId, operationId, post }
}

async function settle(sessionId: string, requestId: string) {
  const taker = `session:${sessionId}`
  const write = await botQuestionNotices(b, taker, [requestId])
  reconcileQuestions(bDb, idle, write, taker)
  const route = bDb.getPeerMailMessage(requestId)!
  const rows = bDb.listPendingFederationRelay(route.conversation_id, 'to_home', 50)
  const conversation = aDb.getPeerMailConversation(route.conversation_id)!
  for (const row of rows) {
    storePeerReply(
      a,
      aDb,
      conversation,
      row.message_id!,
      PeerMailRelayPayload.parse(JSON.parse(row.payload))
    )
  }
  remoteRoomMailArrived(groups, 'origin')
  remoteRoomMailArrived(groups, 'other')
  return rows
}

it('posts a remote final answer once in its originating room, preserving Home, private chats and other rooms', async () => {
  const home = journals.get(HOME)!
  const privateBody = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'Private request' }]
  }
  home.send('private-operation', privateBody, 'private-turn')
  home.finish('private-operation', 'private-turn', 'Private Home answer')
  const beforeHome = home.words()
  const privateId = '22222222-2222-4222-8222-222222222222'
  await launch.create(privateId)
  const privateChat = journals.get(privateId)!
  privateChat.send('direct-operation', privateBody, 'direct-turn')
  privateChat.finish('direct-operation', 'direct-turn', 'Private direct answer')
  const beforePrivate = privateChat.words()
  const first = await mention()
  const other = await mention('other')
  expect(other.sessionId).not.toBe(first.sessionId)
  const thread = await mention('origin', 'another-thread')
  expect(thread.sessionId).not.toBe(first.sessionId)
  const journal = journals.get(first.sessionId)!
  journal.finish(first.operationId, first.requestId, 'The build passed.')
  journal.send('later-operation', privateBody, 'later-turn')
  journal.finish('later-operation', 'later-turn', 'Unrelated later answer')
  const rows = await settle(first.sessionId, first.requestId)
  expect(await settle(first.sessionId, first.requestId)).toHaveLength(1)
  expect(rows).toHaveLength(1)
  expect(bDb.getBotRequestOutcome(first.requestId)).toBe('answered')
  expect(groups.store.message(first.post.id)!.remoteAsks![0].reply).toEqual({
    kind: 'answer',
    text: 'The build passed.'
  })
  expect(groups.store.message(other.post.id)!.remoteAsks![0].reply).toBeUndefined()
  expect(home.words()).toEqual(beforeHome)
  expect(privateChat.words()).toEqual(beforePrivate)
  expect(journals.get(other.sessionId)!.words()).not.toContain('The build passed.')
  expect(journals.get(thread.sessionId)!.words()).not.toContain('The build passed.')
  expect(botChatRecordRow(records.get(first.sessionId)!, (id) => id, HOME)).toBeNull()
  expect(botChatRecordRow(records.get(HOME)!, (id) => id, HOME)?.home).toBe(true)
  const directId = generateId('msg')
  await deliverPeerMailToBot(
    b,
    {
      conversationId: generateId('peerconv'),
      messageId: directId,
      to: `bot:${bot.id}`,
      chat: privateId,
      senderLabel: 'Test sender',
      subject: 'Private question',
      type: 'question'
    },
    'pairing',
    undefined
  )
  expect(bDb.getMessageById(directId)!.to_handle).toBe(`orca_session_id:${privateId}`)
  vi.mocked(a.callOrchestrationWorkerServer).mockImplementation(async () => ({
    ...b.getStatus(),
    capabilities: b
      .getStatus()
      .capabilities!.filter(
        (capability) => capability !== ORCHESTRATION_PEER_GROUP_MAIL_RUNTIME_CAPABILITY
      )
  }))
  const refused = await queueMention()
  expect(bDb.getMessageById(refused.requestId)).toBeUndefined()
  expect(groups.store.message(refused.post.id)!.remoteAsks![0].state).toBe('failed')
  expect(home.words()).toEqual(beforeHome)
  const historyIds = [HOME, privateId, first.sessionId, other.sessionId, thread.sessionId]
  installChats(historyIds.map((id) => codexChatHolding(id, [`provider-${id}`])))
  const history = projectStructuredAiVaultSessions(
    {
      ...listResult(),
      sessions: historyIds.map((id) => historySession({ sessionId: `provider-${id}` }))
    },
    () => true
  )
  expect(history.sessions.map((session) => session.sessionId)).toEqual([
    `provider-${HOME}`,
    `provider-${privateId}`
  ])
})

it('keeps an explicit reply authoritative and preserves failure, empty and NO_REPLY notices', async () => {
  for (const [index, [text, outcome]] of [
    ['Final after explicit reply', 'success'],
    ['Partial failure', 'failure'],
    ['', 'success'],
    ['NO_REPLY', 'success'],
    ['Nothing to send. NO_REPLY', 'success']
  ].entries()) {
    const ask = await mention()
    if (index === 0) {
      await replyOverPeerMail({
        runtime: b,
        original: bDb.getMessageById(ask.requestId)!,
        route: bDb.getPeerMailMessage(ask.requestId)!,
        params: { body: 'Explicit answer' },
        orchestrationCaller: undefined,
        orchestrationMutation: undefined,
        recordMutationReceipt: undefined
      })
    }
    journals
      .get(ask.sessionId)!
      .finish(ask.operationId, ask.requestId, text!, outcome === 'failure' ? 'failure' : 'success')
    await settle(ask.sessionId, ask.requestId)
    expect(groups.store.message(ask.post.id)!.remoteAsks![0].reply).toEqual(
      index === 0 ? { kind: 'answer', text: 'Explicit answer' } : { kind: 'notice' }
    )
    expect(bDb.getBotRequestOutcome(ask.requestId)).toBe(index === 0 ? 'answered' : 'unanswered')
  }
})
