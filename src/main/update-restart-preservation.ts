import {
  preserveAgentAuthBeforeRestart,
  type CodexRuntimeAuthSync
} from './agent-auth-restart-preservation'
import type { Store } from './persistence'

/** Before any update restart, desktop or headless serve: save agent auth, then a full store checkpoint. */
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
