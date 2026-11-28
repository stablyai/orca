// Where an item's linked worker is, by its Dispatch: the host finds it (reopening a terminal Orca closed),
// so a worker opens even when the Chats tree hasn't loaded its page.
import {
  structuredSessionOpenFailure,
  type StructuredSessionOpenFailure
} from '../../../../src/shared/agent-session/view/open-structured-agent-session'
import type { BotChatTreeWorker } from '../../../../src/shared/bots/bot-chat-tree'
import { mobileStructuredSessionOpenMessage } from '../../session/native-chat/agent-session/mobile-structured-session-open-message'
import { openMobileStructuredSession } from '../../session/native-chat/agent-session/open-mobile-structured-session'
import { openMobileAgentMessageTerminal } from '../../session/tabs/mobile-agent-message-terminal'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { chatPaneKey } from '../../../../src/shared/agent-session/view/structured-agent-session-projection'

async function locateBotItemWorker(
  client: RpcClient,
  dispatchId: string,
  current: () => boolean
): Promise<{ worktreeId: string; paneKey: string } | { failure: StructuredSessionOpenFailure }> {
  const deadline = Date.now() + 15_000
  try {
    const result = await openMobileStructuredSession({
      client,
      current,
      source: {
        kind: 'sender',
        party: { address: `dispatch:${dispatchId}`, terminalHandle: null, orcaSessionId: null },
        messageIds: []
      }
    })
    switch (result.kind) {
      case 'opened':
        return {
          worktreeId: result.target.worktreeId,
          paneKey: chatPaneKey(result.target.sessionId)
        }
      case 'terminal':
        return await openMobileAgentMessageTerminal(client, result.handle, current, deadline)
      case 'failed':
        return { failure: result.failure }
      case 'superseded':
        return { failure: { reason: 'unknown', beforeEffects: true } }
    }
  } catch (error) {
    return { failure: structuredSessionOpenFailure(error) }
  }
}

/** Opens a worker at its known pane; a chat worker, or one with no place loaded, where the host finds its
 *  Dispatch (its chat, a `/clear` successor's, or a reopened terminal). */
export function openBotItemWorker(
  worker: BotChatTreeWorker,
  deps: {
    client: RpcClient | null
    loaded: readonly BotChatTreeWorker[]
    open: (worker: BotChatTreeWorker) => void
    current: () => boolean
    showToast: (message: string) => void
  }
): void {
  const known =
    (worker.dispatchId && deps.loaded.find((entry) => entry.dispatchId === worker.dispatchId)) ||
    worker
  const { dispatchId } = known
  if (known.worktreeId && (known.paneKey || !dispatchId || !deps.client)) {
    deps.open(known)
    return
  }
  if (!deps.client || !dispatchId) {
    return
  }
  void locateBotItemWorker(deps.client, dispatchId, deps.current).then((found) => {
    if (!('failure' in found)) {
      deps.open({ ...known, ...found })
    } else if (deps.current()) {
      const { reason, surface, workspaceKind } = found.failure
      deps.showToast(
        mobileStructuredSessionOpenMessage(reason, known.title, surface, workspaceKind)
      )
    }
  })
}
