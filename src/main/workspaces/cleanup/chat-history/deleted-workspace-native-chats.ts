import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionLeaseIsReleased } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { WORKSPACE_CLEANUP_RULE_GRACE_MS } from '../../../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import { splitWorktreeId } from '../../../../shared/worktree/id'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { agentSessionRecordLastUsedAt } from '../../../runtime/agent-session/records/agent-session-record-forget'
import type { ChatHistorySweepResult } from './gone-workspace-folder-groups'

/**
 * The workspace folder of a chat this host ran natively in a git worktree and nothing holds now.
 * A chat's location never moves, so its workspace is where all its history belongs.
 */
export function nativeChatWorkspaceFolder(record: AgentSessionRecord, now: number): string | null {
  const { location } = record
  if (
    normalizeExecutionHostId(location.executionHostId) !== LOCAL_EXECUTION_HOST_ID ||
    location.wslDistro !== null ||
    location.workspaceKind !== 'git-worktree' ||
    !agentSessionLeaseIsReleased(record.lease) ||
    now - agentSessionRecordLastUsedAt(record) < WORKSPACE_CLEANUP_RULE_GRACE_MS
  ) {
    return null
  }
  const path = splitWorktreeId(location.workspaceId)?.worktreePath
  return path && !parseWslUncPath(path) ? path : null
}

/**
 * Only an installed chat host has reconciled every lease since launch and knows which chats are
 * open; without one, every saved lease reads unreconciled and nothing could be proven at rest.
 */
export function listHostNativeChats(): AgentSessionRecord[] {
  const store = getStructuredAgentSessionHost()?.deps.store
  return store && !store.readOnly ? store.listRecords() : []
}

/**
 * Each chat is deleted in its conversation lane, so no open or start can race it. `shouldForget`
 * runs before the lane and again there after any conversion of the chat, right before the store
 * re-checks it is at rest. Newest first: a /clear continuation goes before the chat it came from.
 */
export async function forgetHostNativeChats(
  chats: readonly AgentSessionRecord[],
  shouldForget: (chat: AgentSessionRecord) => Promise<boolean>
): Promise<ChatHistorySweepResult> {
  const result: ChatHistorySweepResult = { deleted: 0, failed: 0, freedBytes: 0 }
  for (const chat of [...chats].sort((left, right) => right.createdAt - left.createdAt)) {
    if (!(await shouldForget(chat))) {
      continue
    }
    const host = getStructuredAgentSessionHost()
    if (!host || host.deps.store.readOnly) {
      return result
    }
    const { sessionId, location } = chat
    let forgotten = false
    try {
      forgotten = await host.serialize(sessionId, async () => {
        // Any history read opens the conversation, so an open one may be on screen. A worker that
        // still owes a dispatch is settled through its record, so it stays until that is done.
        if (host.hasSession(sessionId) || host.deps.hasOpenDispatch?.(chat)) {
          return false
        }
        const tabShown = host.isSessionTabVisible(sessionId)
        const deleted = await host.deps.store.forgetIdleChat(
          { sessionId, location, idleBefore: Date.now() - WORKSPACE_CLEANUP_RULE_GRACE_MS },
          () => shouldForget(chat)
        )
        if (deleted && tabShown) {
          await closeForgottenChatTab(host, sessionId)
        }
        return deleted
      })
    } catch (error) {
      console.warn('[workspace-cleanup] Deleting a chat of a deleted workspace failed', error)
      result.failed += 1
    }
    result.deleted += forgotten ? 1 : 0
  }
  return result
}

/** A shown tab was seeded into status lists: close it the usual way so its sink rows go too. */
async function closeForgottenChatTab(
  host: NonNullable<ReturnType<typeof getStructuredAgentSessionHost>>,
  sessionId: string
): Promise<void> {
  await host.setSessionTabVisibility(sessionId, false).catch((error: unknown) => {
    console.warn('[workspace-cleanup] Closing a deleted chat tab failed', error)
  })
}
