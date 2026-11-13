import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { mainProcessState as state } from '../main-process-state'

// Background chat-journal maintenance waits for this Electron host's serving milestone.
const serving = Promise.withResolvers<void>()

/** Serve boots the saved-chat writer now; desktop waits for the first-window fence, so window creation keeps the disk. */
export function beginChatJournalStartup(runtime: OrcaRuntimeService, serveMode: boolean): void {
  if (serveMode) {
    runtime.beginStructuredAgentSessionStartupOpen(serving.promise)
    return
  }
  void state.firstWindowStartupServicesReady.then(
    () => runtime.beginStructuredAgentSessionStartupOpen(serving.promise),
    () => {}
  )
}

export function chatJournalHostServing(): void {
  serving.resolve()
}
