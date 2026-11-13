import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { isHostShuttingDown } from '../quit/host-shutdown-state'
import { mainProcessState as state } from '../main-process-state'

// Background chat-journal maintenance waits for this Electron host's serving milestone.
const serving = Promise.withResolvers<void>()

/** Serve boots the saved-chat writer now; desktop waits for the first-window fence, so window creation keeps the disk. */
export function beginChatJournalStartup(
  runtime: Pick<OrcaRuntimeService, 'beginStructuredAgentSessionStartupOpen'>,
  serveMode: boolean
): void {
  if (serveMode) {
    runtime.beginStructuredAgentSessionStartupOpen(serving.promise)
    return
  }
  void state.firstWindowStartupServicesReady.then(
    () => {
      // A fence that settles after quit or failed startup committed must not open past teardown.
      if (!isHostShuttingDown()) {
        runtime.beginStructuredAgentSessionStartupOpen(serving.promise)
      }
    },
    () => {}
  )
}

export function chatJournalHostServing(): void {
  serving.resolve()
}
