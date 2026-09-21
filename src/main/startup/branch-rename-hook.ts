import { maybeAutoRenameBranchOnFirstWork } from '../agent-hooks/first-work-branch-rename'
import { firstWorkRenameDeps } from '../agent-hooks/first-work-rename-runtime'
import { mainProcessState as state } from './main-process-state'

// Why: inject the index.ts store/runtime singletons so the rename orchestrator stays module-state-free and unit-testable.
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
