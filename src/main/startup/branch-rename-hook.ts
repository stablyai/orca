import { maybeAutoRenameBranchOnFirstWork } from '../agent-hooks/first-work-branch-rename'
import { firstWorkRenameDeps } from '../agent-hooks/first-work-rename-runtime'
import { agentHookServer } from '../agent-hooks/server'
import { mainProcessState as state } from './main-process-state'

/** Arms first-work rename from the hook store itself, so headless serve (no window) renames too. */
export function installFirstWorkRenameHookSubscription(): () => void {
  return agentHookServer.subscribeEnrichedStatus((event) => {
    // Identity refreshes/restored history are not new turns; structured sessions use their own rename seam.
    if (event.providerSessionOnly || event.restoredUnconfirmed || event.structuredHost) {
      return
    }
    maybeAutoRenameBranchOnFirstWorkFromHook({
      paneKey: event.paneKey,
      tabId: event.tabId,
      worktreeId: event.worktreeId,
      payload: event.payload,
      isReplay: event.isReplay
    })
  })
}

// Inject startup singletons so the rename orchestrator stays module-state-free and testable.
export function maybeAutoRenameBranchOnFirstWorkFromHook(event: {
  paneKey: string
  tabId: string | undefined
  worktreeId: string | undefined
  payload: { state: string; prompt?: string; lastAssistantMessage?: string }
  isReplay: boolean | undefined
}): void {
  const store = state.store
  const runtime = state.runtime
  if (!store || !runtime) {
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
    firstWorkRenameDeps(store, runtime)
  )
}
