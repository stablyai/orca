import {
  preserveAgentAuthBeforeRestart,
  type CodexRuntimeAuthSync
} from './agent-auth-restart-preservation'
import type { Store } from './persistence'

// Save agent auth before checkpointing the store on desktop and headless restarts.
export async function preserveStateBeforeUpdateRestart({
  codexRuntimeHome,
  store
}: {
  codexRuntimeHome: CodexRuntimeAuthSync | null | undefined
  store: Pick<Store, 'flushPendingOrThrowAsync'>
}): Promise<void> {
  await preserveAgentAuthBeforeRestart({ codexRuntimeHome, store })
  await store.flushPendingOrThrowAsync({ fullCheckpoint: true })
}
