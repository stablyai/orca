import {
  maybeAutoRenameBranchOnFirstWork,
  type FirstWorkBranchRenameDeps
} from './first-work-branch-rename'
import { agentHookServer } from './server'

export function installFirstWorkRenameHookSubscription(
  deps: FirstWorkBranchRenameDeps
): () => void {
  return agentHookServer.subscribeEnrichedStatus((event) => {
    // Identity refreshes/restored history are not new turns; structured sessions use their own rename seam.
    if (event.providerSessionOnly || event.restoredUnconfirmed || event.structuredHost) {
      return
    }
    void maybeAutoRenameBranchOnFirstWork(
      {
        paneKey: event.paneKey,
        tabId: event.tabId,
        worktreeId: event.worktreeId,
        state: event.payload.state,
        prompt: event.payload.prompt,
        assistantMessage: event.payload.lastAssistantMessage,
        isReplay: event.isReplay
      },
      deps
    )
  })
}
