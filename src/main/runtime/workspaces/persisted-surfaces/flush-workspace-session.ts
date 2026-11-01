import type { RuntimeStore } from '../../runtime-store-contract'

export async function flushWorkspaceSessionOrThrowAsync(
  store: Pick<RuntimeStore, 'flushOrThrow' | 'flushPendingOrThrowAsync'> | null
): Promise<void> {
  if (store?.flushPendingOrThrowAsync) {
    await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    return
  }
  if (store?.flushOrThrow) {
    store.flushOrThrow()
    return
  }
  throw new Error('workspace_session_persistence_unavailable')
}
