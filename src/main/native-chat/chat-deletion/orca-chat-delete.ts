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
import { isBotGroupMemberSession } from '../../../shared/bots/bot-group'
import type { OrcaChatDeleteResult } from '../../../shared/agent-session/chat-deletion/orca-chat-delete'
import type { AiVaultAgent } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { listAiVaultSessions } from '../../ai-vault/listing/cached-session-list'
import { historyRowOwnershipsLookup } from '../../ai-vault/structured-sessions/history-row-ownership-lookup'
import { createCanonicalOrcaSessionResolver } from '../../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import { readAgentSessionRecordStore } from '../../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { readDispatchWorkers } from '../../runtime/rpc/methods/orchestration/worker/session-workers-method'
import { dropUnreadBotRequests } from '../../runtime/rpc/methods/orchestration/messaging/bot-request-outcome'
import { runtimeBotChats } from '../../bots/bot-chat-session'
import { botOfSession } from '../../bots/bot-session-tabs'
import { closeStructuredAgentSessionChild } from '../../runtime/agent-session/lifecycle/structured-agent-session-close'
import { deleteHostChatTranscriptsPermanently } from '../../workspaces/cleanup/chat-history/deleted-workspace-chat-history'
import { forgetNativeChatInLane } from '../../workspaces/cleanup/chat-history/deleted-workspace-native-chats'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { getStructuredAgentSessionHost } from '../agent-session-wire/host/structured-agent-session-registry'

type Transcript = { agent: AiVaultAgent; sessionId: string; filePath: string }

/** A session's chat: the first session of its /clear lineage. */
export function chatRootResolver(): (sessionId: string) => string {
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

/** Whether a Dispatch any session of the chat created is unsettled with a worker that may still run.
 *  Every unsettled one, however old; a liveness this host can't prove, or a failed read, counts. */
async function ownsLiveWorkers(
  runtime: OrcaRuntimeService,
  records: readonly AgentSessionRecord[]
): Promise<boolean> {
  try {
    const open = runtime
      .getOrchestrationDb()
      .listDispatchesCreatedByAny(
        { orcaSessionIds: records.map((record) => record.sessionId), paneKeys: [] },
        0
      )
    if (open.length === 0) {
      return false
    }
    const ended = new Set(
      (
        await readDispatchWorkers(
          runtime,
          open.map((dispatch) => dispatch.id)
        )
      )
        .filter((worker) => worker.state !== 'working' && worker.state !== 'unverifiable')
        .map((worker) => worker.dispatchId)
    )
    return open.some((dispatch) => !ended.has(dispatch.id))
  } catch (error) {
    console.warn('[chat-delete] could not read the chat workers', error)
    return true
  }
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

/** The chats holding a history row's conversation, across every provider that can own the row. */
function historyRowHolders(): ((row: Transcript) => string[]) | null {
  const owners = historyRowOwnershipsLookup()
  return (
    owners &&
    ((row) =>
      owners(row)
        .flat()
        .map((ownership) => ownership.sessionId))
  )
}

/** The agent transcripts Session History lists under these chats and no other chat holds, read
 *  while the chats still exist. Null when the scan failed. */
async function listChatTranscripts(
  records: readonly AgentSessionRecord[]
): Promise<Transcript[] | null> {
  const folders = [...new Set(records.flatMap((record) => transcriptFolder(record) ?? []))]
  const holders = historyRowHolders()
  if (folders.length === 0 || !holders) {
    return []
  }
  const ids = new Set(records.map((record) => record.sessionId))
  try {
    const { sessions } = await listAiVaultSessions({
      unlimited: true,
      scopePaths: folders,
      scopeOnly: true
    })
    return sessions.flatMap((session) => {
      const held = session.executionHostId === LOCAL_EXECUTION_HOST_ID ? holders(session) : []
      return held.length > 0 && held.every((id) => ids.has(id))
        ? [{ agent: session.agent, sessionId: session.sessionId, filePath: session.filePath }]
        : []
    })
  } catch (error) {
    console.warn('[chat-delete] could not list the chat transcripts', error)
    return null
  }
}

/** Removes the transcripts once the chats are gone, each only while no chat holds its conversation
 *  any more (checked right before the unlink). False when any stays: an agent Orca can't delete
 *  history for, or a failed removal. */
async function deleteTranscripts(
  runtime: OrcaRuntimeService,
  transcripts: readonly Transcript[]
): Promise<boolean> {
  if (transcripts.length === 0) {
    return true
  }
  const byPath = new Map(transcripts.map((transcript) => [transcript.filePath, transcript]))
  try {
    const result = await deleteHostChatTranscriptsPermanently(
      runtime.requireStore(),
      transcripts,
      async (target) => {
        const transcript = byPath.get(target.filePath)
        const holders = historyRowHolders()
        return Boolean(transcript && holders && holders(transcript).length === 0)
      }
    )
    return result.failed === 0
  } catch (error) {
    console.warn('[chat-delete] a deleted chat kept its transcript', error)
    return false
  }
}

/**
 * Deletes the chat `sessionId` belongs to. A bot's Home Chat is cleared: a fresh Home takes its place
 * first. Check, then commit: every refusal is decided before anything changes. The commit's own
 * steps (the Home reset, each close, each forget) recheck in their session's lane, so a turn or open
 * that slips in after the checks refuses there; nothing irreversible (mail notices, transcripts) runs
 * until every session of the chat is forgotten.
 */
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
  // A group room routes its messages to each member's session, so a member's chat isn't one to delete.
  if (chat.records.some((record) => isBotGroupMemberSession(record.sessionId))) {
    return { outcome: 'refused', reason: 'group' }
  }
  if (chat.records.some((record) => record.lastTurn?.state === 'open')) {
    return { outcome: 'refused', reason: 'replying' }
  }
  if (await ownsLiveWorkers(runtime, chat.records)) {
    return { outcome: 'refused', reason: 'workers' }
  }
  const transcripts = await listChatTranscripts(chat.records)
  const bot = botOfSession(runtime.bots, chat.root)
  const home = chat.records.find((record) => record.sessionId === bot?.chatSessionId)
  if (bot && home) {
    // Never the live Home in place: a fresh one takes over, then the old one is an ordinary chat.
    if ((await runtimeBotChats(runtime).clearHome(bot.id, home.sessionId)) === 'busy') {
      return { outcome: 'refused', reason: 'replying' }
    }
  }
  // A chat viewed lately stays loaded with its tab open: stop it and close its tab on every client,
  // as a closed tab would, only while it is proven at rest.
  for (const record of chat.records) {
    const closed = await closeStructuredAgentSessionChild(record.sessionId, {
      runtime,
      admitClose: (work) => work.state === 'idle'
    })
    if (!closed.stopped) {
      return { outcome: 'refused', reason: 'replying' }
    }
  }
  for (const record of chat.records) {
    const outcome = await forgetNativeChatInLane(record, Number.MAX_SAFE_INTEGER, async () => true)
    if (outcome !== 'forgotten') {
      return { outcome: 'refused', reason: outcome === 'open' ? 'replying' : 'unavailable' }
    }
  }
  if (bot) {
    for (const record of chat.records) {
      // Mail it never read goes unanswered, and its senders hear so.
      await dropUnreadBotRequests(
        runtime,
        bot.id,
        home ? 'new-chat' : 'chat-deleted',
        record.sessionId
      )
      await runtime.botWork.forget(record.sessionId).catch(() => false)
    }
  }
  const historyGone = transcripts !== null && (await deleteTranscripts(runtime, transcripts))
  return historyGone ? { outcome: 'deleted' } : { outcome: 'deleted', historyKept: true }
}
