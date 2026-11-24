import type { Repo } from '../../../shared/repository/repo-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  planOrphanedChatRekeys,
  type ChatLocationView
} from '../../../shared/repository/orphaned-chat-rekey'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  forgetRemovedProject,
  readProjectIdentity,
  settledRemovedProjects
} from './removed-project-ledger'

type ChatStore = {
  listConversations: () => readonly ChatLocationView[]
  updateRecord: (
    sessionId: string,
    command: { kind: 'workspace'; from: string; to: string }
  ) => Promise<unknown>
}

type ChatTabs = { showSessionTabs: (sessionIds: readonly string[]) => Promise<unknown> }
type ChatTabList = {
  listSessionTabs: () => readonly { sessionId: string; workspaceId: string }[]
}

/** Chats of one project that have an open tab right now, in tab order. Call before the removal closes them. */
export function listOpenChatSessionIds(
  repoId: string,
  host: () => ChatTabList | null = defaultChatHost
): string[] {
  try {
    return (host()?.listSessionTabs() ?? [])
      .filter((tab) => getRepoIdFromWorktreeId(tab.workspaceId) === repoId)
      .map((tab) => tab.sessionId)
  } catch {
    return []
  }
}

/**
 * Moves the chats of a removed project onto a re-added project's new repo id (stablyai/orca#40409).
 * Waits for any removal still tearing down; never throws (the add has already succeeded).
 */
export async function restoreOrphanedChats(
  repo: Repo,
  deps: {
    isLive: (repoId: string) => boolean
    chatStore?: () => ChatStore | null
    chatTabs?: () => ChatTabs | null
    readIdentity?: typeof readProjectIdentity
  }
): Promise<number> {
  try {
    const kind = repo.kind ?? 'git'
    const [identity, tombstones] = await Promise.all([
      (deps.readIdentity ?? readProjectIdentity)(repo.path, kind),
      settledRemovedProjects()
    ])
    // The re-added project may itself have been removed while we waited; a revived old id is left alone.
    const candidates = tombstones.filter((tombstone) => !deps.isLive(tombstone.repoId))
    if (!deps.isLive(repo.id) || candidates.length === 0) {
      return 0
    }
    const store = (deps.chatStore ?? defaultChatStore)()
    if (!store) {
      return 0
    }
    const moves = planOrphanedChatRekeys(store.listConversations(), candidates, repo, identity)
    let moved = 0
    for (const move of moves) {
      try {
        await store.updateRecord(move.sessionId, {
          kind: 'workspace',
          from: move.from,
          to: move.to
        })
        moved++
      } catch (error) {
        console.warn('[projects] could not move a saved chat to the re-added project', error)
      }
    }
    const claimed = new Set(moves.map((move) => getRepoIdFromWorktreeId(move.from)))
    await reopenChatTabs(
      candidates.filter((tombstone) => claimed.has(tombstone.repoId)),
      new Set(moves.map((move) => move.sessionId)),
      (deps.chatTabs ?? defaultChatHost)()
    )
    for (const repoId of claimed) {
      forgetRemovedProject(repoId)
    }
    return moved
  } catch (error) {
    console.warn('[projects] could not restore saved chats for the re-added project', error)
    return 0
  }
}

/** The removal closed the chat tabs; give back the ones that were open, so the sidebar rows return. */
async function reopenChatTabs(
  claimed: readonly { openSessionIds?: readonly string[] }[],
  movedSessionIds: ReadonlySet<string>,
  tabs: ChatTabs | null
): Promise<void> {
  const ids = [...new Set(claimed.flatMap((tombstone) => tombstone.openSessionIds ?? []))].filter(
    (id) => movedSessionIds.has(id)
  )
  if (!tabs || ids.length === 0) {
    return
  }
  try {
    await tabs.showSessionTabs(ids)
  } catch (error) {
    console.warn('[projects] could not reopen the saved chats of the re-added project', error)
  }
}

function defaultChatHost() {
  return getStructuredAgentSessionHost()
}

function defaultChatStore(): ChatStore | null {
  return getStructuredAgentSessionHost()?.deps.store ?? null
}
