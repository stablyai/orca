import {
  preserveAgentAuthBeforeRestart,
  type CodexRuntimeAuthSync
} from '../providers/accounts/agent-auth-restart-preservation'
import type { Store } from '../persistence/loading-store/store'
import { withUpdaterSpan } from '../observability/instrumentation'

// Save agent auth before checkpointing the store on desktop and headless restarts.
export async function preserveStateBeforeUpdateRestart({
  codexRuntimeHome,
  store
}: {
  codexRuntimeHome: CodexRuntimeAuthSync | null | undefined
  store: Pick<Store, 'flushPendingOrThrowAsync'>
}): Promise<void> {
  await withUpdaterSpan({ stage: 'preserve-agent-auth' }, () =>
    preserveAgentAuthBeforeRestart({ codexRuntimeHome })
  )
  // Normal quit saves later mutations. Waiting for the live app to stop changing can strand a restart.
  await store.flushPendingOrThrowAsync({ fullCheckpoint: true, drainToStableGeneration: false })
}
