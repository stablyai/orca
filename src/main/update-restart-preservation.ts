import type { CodexRuntimeAuthSync } from './agent-auth-restart-preservation'
import type { Store } from './persistence'
import { app } from 'electron'
import { createUpdateProfileSnapshot } from './update-profile-snapshot'

// Save agent auth before checkpointing the store on desktop and headless restarts.
export async function preserveStateBeforeUpdateRestart({
  codexRuntimeHome,
  store
}: {
  codexRuntimeHome: CodexRuntimeAuthSync | null | undefined
  store: Pick<Store, 'flushPendingOrThrowAsync'>
}): Promise<void> {
  // An update must not proceed after losing the most recent credential selection.
  codexRuntimeHome?.syncForCurrentSelection()
  await codexRuntimeHome?.syncActiveWslSelectionsBeforeRestart?.()
  await store.flushPendingOrThrowAsync({ fullCheckpoint: true })
  await createUpdateProfileSnapshot(app.getPath('userData'), app.getVersion())
}
