import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { isHostShuttingDown } from '../quit/host-shutdown-state'
import { mainProcessState as state } from '../main-process-state'
import { provideManagedAgentDetection } from '../../runtime/rpc/methods/host-management/managed-copy-detection'
import {
  reclaimManagedRuntimeReleasesAtLaunch,
  startManagedRuntimeAutoUpdates
} from '../../runtime/rpc/methods/host-management/managed-runtime-install'

// Background chat-journal maintenance waits for this Electron host's serving milestone.
const serving = Promise.withResolvers<void>()
// Desktop's automatic journal work also waits for the first-window fence; serve has none.
let windowFence: Promise<unknown> = Promise.resolve()

/** Serve boots the saved-chat writer now; desktop waits for the first-window fence, so window creation keeps the disk. */
export function beginChatJournalStartup(
  runtime: Pick<OrcaRuntimeService, 'beginStructuredAgentSessionStartupOpen' | 'requireStore'>,
  serveMode: boolean
): void {
  // Detection counts Orca's copies from launch, before the release reclaim in chatJournalHostServing.
  provideManagedAgentDetection(runtime)
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

/** Serving milestone: maintenance, CI-line watches and runtime release reclaim start after the bounded first-window fence, never the renderer. */
export function chatJournalHostServing(): void {
  serving.resolve()
  void windowFence
    .catch(() => {})
    .then(() => {
      if (state.core.runtime) {
        state.core.runtime.startPullRequestWatches({ admit: true })
        reclaimManagedRuntimeReleasesAtLaunch(state.core.runtime)
        startManagedRuntimeAutoUpdates()
      }
    })
}
