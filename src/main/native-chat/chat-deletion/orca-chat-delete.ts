// The user's Delete chat: an Orca chat at rest goes for good on the host that owns its store, with its
// /clear lineage, its tab and the agent's own transcript, so neither Session History nor a resume
// brings it back. Memory, items and connector threads stay.
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { isOrcaSessionId } from '../../../shared/agent-session/identity/orca-session-address'
import { splitWorktreeId } from '../../../shared/worktree/id'
import type { OrcaChatDeleteResult } from '../../../shared/agent-session/chat-deletion/orca-chat-delete'
import type { AiVaultAgent } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { listAiVaultSessions } from '../../ai-vault/listing/cached-session-list'
import { deleteAiVaultSessionForRemoteClient } from '../../ai-vault/deletion/host-session-delete'
import { historyRowOwnershipLookup } from '../../ai-vault/structured-sessions/history-row-ownership-lookup'
import { deleteCodexRolloutsPermanently } from '../../codex/history/cleanup/codex-rollout-permanent-delete'
import { listHostCodexRolloutHomes } from '../../codex/history/cleanup/codex-host-rollout-homes'
import { createCanonicalOrcaSessionResolver } from '../../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import { readAgentSessionRecordStore } from '../../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { readSessionWorkers } from '../../runtime/rpc/methods/orchestration/worker/session-workers-method'
import { dropUnreadBotRequests } from '../../runtime/rpc/methods/orchestration/messaging/bot-request-outcome'
import { runtimeBotChats } from '../../bots/bot-chat-session'
import { botOfSession } from '../../bots/bot-session-tabs'
import { closeStructuredAgentSessionChild } from '../../runtime/agent-session/lifecycle/structured-agent-session-close'
import { forgetNativeChatInLane } from '../../workspaces/cleanup/chat-history/deleted-workspace-native-chats'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { getStructuredAgentSessionHost } from '../agent-session-wire/host/structured-agent-session-registry'

type Transcript = { agent: AiVaultAgent; sessionId: string; filePath: string }

/** A session's chat: the first session of its /clear lineage. */
function chatRootResolver(): (sessionId: string) => string {
  const resolve = createCanonicalOrcaSessionResolver(readAgentSessionRecordStore())
  return (sessionId) => (isOrcaSessionId(sessionId) ? resolve(sessionId) : sessionId)
}

/** The chat a session belongs to: every record its /clear lineage shares, newest first. */
function chatLineage(sessionId: string): { root: string; records: AgentSessionRecord[] } | null {
  const store = getStructuredAgentSessionHost()?.deps.store
  if (!store?.getRecord(sessionId)) {
    return null
  }
  const rootOf = chatRootResolver()
  const root = rootOf(sessionId)
  const records = store
    .listRecords()
    .filter((record) => rootOf(record.sessionId) === root)
    .sort((left, right) => right.createdAt - left.createdAt)
  return { root, records }
}

async function ownsRunningWorkers(
  runtime: OrcaRuntimeService,
  records: readonly AgentSessionRecord[]
): Promise<boolean> {
  for (const record of records) {
    const workers = await readSessionWorkers(runtime, record.sessionId).catch(() => [])
    if (workers.some((worker) => worker.state === 'working')) {
      return true
    }
  }
  return false
}

/** Where the agent wrote its transcript: the chat's launch folder on this host, not WSL's. */
function transcriptFolder(record: AgentSessionRecord): string | null {
  const { location } = record
  if (
    normalizeExecutionHostId(location.executionHostId) !== LOCAL_EXECUTION_HOST_ID ||
    location.wslDistro !== null
  ) {
    return null
  }
  return (
    record.launchDirectory ??
    (location.workspaceKind === 'git-worktree'
      ? (splitWorktreeId(location.workspaceId)?.worktreePath ?? null)
      : null)
  )
}

/** The agent transcripts Session History lists under these chats, read while the chats still exist. */
async function listChatTranscripts(records: readonly AgentSessionRecord[]): Promise<Transcript[]> {
  const folders = [...new Set(records.flatMap((record) => transcriptFolder(record) ?? []))]
  const owner = historyRowOwnershipLookup()
  if (folders.length === 0 || !owner) {
    return []
  }
  const ids = new Set(records.map((record) => record.sessionId))
  const { sessions } = await listAiVaultSessions({
    unlimited: true,
    scopePaths: folders,
    scopeOnly: true
  })
  return sessions.flatMap((session) => {
    const owned = owner(session)
    return session.executionHostId === LOCAL_EXECUTION_HOST_ID && owned && ids.has(owned.sessionId)
      ? [{ agent: session.agent, sessionId: session.sessionId, filePath: session.filePath }]
      : []
  })
}

/** Best effort: the chat is already gone, so a transcript that stays is logged, not refused. */
async function deleteTranscripts(
  runtime: OrcaRuntimeService,
  transcripts: readonly Transcript[]
): Promise<void> {
  const codex = transcripts.filter((transcript) => transcript.agent === 'codex')
  for (const transcript of transcripts.filter((entry) => entry.agent !== 'codex')) {
    // This host's own delete: the Trash on a desktop, removed outright on a server.
    const result = await deleteAiVaultSessionForRemoteClient(transcript).catch(
      (error: unknown) => ({ outcome: String(error) })
    )
    if (result.outcome !== 'deleted') {
      console.warn('[chat-delete] a deleted chat kept its transcript', result.outcome)
    }
  }
  if (codex.length > 0) {
    await Promise.resolve()
      .then(() => {
        const settings = runtime.requireStore().getSettings()
        return deleteCodexRolloutsPermanently(
          codex,
          async () => true,
          () => listHostCodexRolloutHomes(settings)
        )
      })
      .catch((error: unknown) => {
        console.warn('[chat-delete] a deleted chat kept its Codex rollout', error)
      })
  }
}

/** Deletes the chat `sessionId` belongs to. A bot's Home Chat is cleared: a fresh Home takes its place first. */
export async function deleteOrcaChat(
  runtime: OrcaRuntimeService,
  sessionId: string
): Promise<OrcaChatDeleteResult> {
  await runtime.ensureStructuredAgentSessionHost()
  const host = getStructuredAgentSessionHost()
  if (!host || host.deps.store.readOnly) {
    return { outcome: 'refused', reason: 'unavailable' }
  }
  const chat = chatLineage(sessionId)
  if (!chat) {
    return { outcome: 'refused', reason: 'not-found' }
  }
  if (await ownsRunningWorkers(runtime, chat.records)) {
    return { outcome: 'refused', reason: 'workers' }
  }
  if (chat.records.some((record) => record.lastTurn?.state === 'open')) {
    return { outcome: 'refused', reason: 'replying' }
  }
  const bot = botOfSession(runtime.bots, chat.root)
  const rootOf = chatRootResolver()
  const home = Boolean(bot?.chatSessionId && rootOf(bot.chatSessionId) === chat.root)
  if (bot && home) {
    // Never the live Home in place: a fresh one takes over, then the old one is an ordinary chat.
    await runtimeBotChats(runtime).reset(bot.id)
  }
  // A chat viewed lately stays loaded with its tab open: stop it and close its tab on every
  // client, as a closed tab would, unless a turn started meanwhile.
  for (const record of chat.records) {
    const closed = await closeStructuredAgentSessionChild(record.sessionId, {
      runtime,
      admitClose: (work) => work.state !== 'busy'
    })
    if (!closed.stopped) {
      return { outcome: 'refused', reason: 'replying' }
    }
  }
  // Mail it never read goes unanswered, and its senders hear so.
  for (const record of bot ? chat.records : []) {
    await dropUnreadBotRequests(
      runtime,
      bot!.id,
      home ? 'new-chat' : 'chat-deleted',
      record.sessionId
    )
  }
  const transcripts = await listChatTranscripts(chat.records).catch((error: unknown) => {
    console.warn('[chat-delete] could not list the chat transcripts', error)
    return []
  })
  for (const record of chat.records) {
    const outcome = await forgetNativeChatInLane(record, Number.MAX_SAFE_INTEGER, async () => true)
    if (outcome === 'open') {
      return { outcome: 'refused', reason: 'replying' }
    }
    if (outcome === 'kept') {
      return { outcome: 'refused', reason: 'unavailable' }
    }
    if (bot) {
      await runtime.botWork.forget(record.sessionId).catch(() => false)
    }
  }
  await deleteTranscripts(runtime, transcripts)
  return { outcome: 'deleted' }
}

/** A deleted agent's chats in its home folder go too, each as Delete chat would; a running one stays. */
export async function deleteChatsInWorkspace(
  runtime: OrcaRuntimeService,
  workspaceId: string
): Promise<void> {
  await runtime.ensureStructuredAgentSessionHost()
  const store = getStructuredAgentSessionHost()?.deps.store
  if (!store || store.readOnly) {
    return
  }
  const rootOf = chatRootResolver()
  const roots = new Set(
    store
      .listRecords()
      .filter((record) => record.location.workspaceId === workspaceId)
      .map((record) => rootOf(record.sessionId))
  )
  for (const root of roots) {
    const result = await deleteOrcaChat(runtime, root).catch((error: unknown) => {
      console.warn('[chat-delete] a deleted agent kept a chat', error)
      return null
    })
    if (result?.outcome === 'refused' && result.reason !== 'not-found') {
      console.warn('[chat-delete] a deleted agent kept a chat', result.reason)
    }
  }
}
