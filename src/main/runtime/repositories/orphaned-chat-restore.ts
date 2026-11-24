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

/**
 * Moves the chats of a removed project onto a re-added project's new repo id (stablyai/orca#40409).
 * Waits for any removal still tearing down; never throws (the add has already succeeded).
 */
export async function restoreOrphanedChats(
  repo: Repo,
  deps: {
    isLive: (repoId: string) => boolean
    chatStore?: () => ChatStore | null
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
    for (const repoId of claimed) {
      forgetRemovedProject(repoId)
    }
    return moved
  } catch (error) {
    console.warn('[projects] could not restore saved chats for the re-added project', error)
    return 0
  }
}

function defaultChatStore(): ChatStore | null {
  return getStructuredAgentSessionHost()?.deps.store ?? null
}
