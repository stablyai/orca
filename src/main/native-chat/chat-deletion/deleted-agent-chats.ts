// A deleted managed agent's chats go with it. The agent and its folder workspace are gone by then, so
// what is left proves it: a chat launched under the agents' root in a folder workspace that no longer
// exists. Read from the chat store each pass, so a restart or a chat busy at delete time is retried
// with nothing extra saved: at startup, after each agent delete, and when such a chat's turn ends.
import { isPathInsideOrEqual } from '../../../shared/file-access/cross-platform-path'
import { isBotGroupMemberSession } from '../../../shared/bots/bot-group'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { botsRootFolder } from '../../bots/bot-home'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { getStructuredAgentSessionHost } from '../agent-session-wire/host/structured-agent-session-registry'
import { chatRootResolver, deleteOrcaChat } from './orca-chat-delete'

let running: Promise<void> | null = null
let again = false
let unsubscribe: (() => void) | null = null

/** The chats a deleted agent left; none when this host can't list its folder workspaces. */
function deletedAgentChats(runtime: OrcaRuntimeService): string[] {
  const store = getStructuredAgentSessionHost()?.deps.store
  const folders = runtime.requireStore().getFolderWorkspaces?.()
  if (!store || store.readOnly || !folders) {
    return []
  }
  const kept = new Set<string>([
    ...folders.map((folder) => folderWorkspaceKey(folder.id)),
    ...runtime.bots.list().map((bot) => folderWorkspaceKey(bot.folderWorkspaceId))
  ])
  const root = botsRootFolder()
  const rootOf = chatRootResolver()
  return [
    ...new Set(
      store
        .listRecords()
        .filter(
          ({ sessionId, location, launchDirectory }) =>
            location.workspaceKind === 'folder' &&
            !kept.has(location.workspaceId) &&
            !isBotGroupMemberSession(sessionId) &&
            launchDirectory !== undefined &&
            isPathInsideOrEqual(root, launchDirectory)
        )
        .map((record) => rootOf(record.sessionId))
    )
  ]
}

async function sweep(runtime: OrcaRuntimeService): Promise<void> {
  await runtime.ensureStructuredAgentSessionHost()
  let waiting = false
  for (const chatId of deletedAgentChats(runtime)) {
    const result = await deleteOrcaChat(runtime, chatId).catch((error: unknown) => {
      console.warn('[chat-delete] a deleted agent kept a chat', error)
      return null
    })
    waiting ||= result?.outcome === 'refused' && result.reason !== 'not-found'
  }
  // A chat still replying or running workers goes once a turn ends; until then nothing polls.
  const host = getStructuredAgentSessionHost()
  if (waiting && !unsubscribe && host) {
    unsubscribe = host.subscribeTurnCompletions({
      id: 'deleted-agent-chats',
      emit: () => deleteChatsOfDeletedAgents(runtime)
    })
  } else if (!waiting && unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
}

/** One pass at a time; a call during one runs it again after. */
export function deleteChatsOfDeletedAgents(runtime: OrcaRuntimeService): void {
  if (running) {
    again = true
    return
  }
  running = sweep(runtime)
    .catch((error: unknown) =>
      console.warn('[chat-delete] deleted agent chats sweep failed', error)
    )
    .finally(() => {
      running = null
      if (again) {
        again = false
        deleteChatsOfDeletedAgents(runtime)
      }
    })
}
