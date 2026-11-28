import type { FirstWorkBranchRenameDeps } from './first-work-branch-rename'
import { agentHookServer } from '../server/agent-hook-server'

export function installFirstWorkRenameHookSubscription(
  deps: FirstWorkBranchRenameDeps
): () => void {
  return agentHookServer.subscribeEnrichedStatus((event) => {
    // Identity refreshes/restored history are not new turns; structured sessions use their own rename seam.
    if (event.providerSessionOnly || event.restoredUnconfirmed || event.structuredHost) {
      return
    }
    const renameEvent = {
      paneKey: event.paneKey,
      tabId: event.tabId,
      worktreeId: event.worktreeId,
      state: event.payload.state,
      prompt: event.payload.prompt,
      assistantMessage: event.payload.lastAssistantMessage,
      isReplay: event.isReplay
    }
    void import('./first-work-branch-rename')
      .then(({ maybeAutoRenameBranchOnFirstWork }) =>
        maybeAutoRenameBranchOnFirstWork(renameEvent, deps)
      )
      .catch((error: unknown) => {
        console.warn('[first-work-rename] failed to load branch rename handler:', error)
      })
  })
}
