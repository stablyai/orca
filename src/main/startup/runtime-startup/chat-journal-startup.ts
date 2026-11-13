import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { isHostShuttingDown } from '../quit/host-shutdown-state'
import { mainProcessState as state } from '../main-process-state'

// Background chat-journal maintenance waits for this Electron host's serving milestone.
const serving = Promise.withResolvers<void>()
// Desktop's automatic journal work also waits for the first-window fence; serve has none.
let windowFence: Promise<unknown> = Promise.resolve()

/** Serve boots the saved-chat writer now; desktop waits for the first-window fence, so window creation keeps the disk. */
export function beginChatJournalStartup(
  runtime: Pick<OrcaRuntimeService, 'beginStructuredAgentSessionStartupOpen'>,
  serveMode: boolean
): void {
  if (serveMode) {
    runtime.beginStructuredAgentSessionStartupOpen(serving.promise)
    return
  }
  windowFence = state.firstWindowStartupServicesReady
  void windowFence.then(
    () => {
      // A fence that settles after quit or failed startup committed must not open past teardown.
      if (!isHostShuttingDown()) {
        runtime.beginStructuredAgentSessionStartupOpen(serving.promise)
      }
    },
    () => {}
  )
}

/** Serving milestone: maintenance and CI-line watches start after the bounded first-window fence, never the renderer. */
export function chatJournalHostServing(): void {
  serving.resolve()
  void windowFence
    .catch(() => {})
    .then(() => state.runtime?.startPullRequestWatches({ admit: true }))
}
