import { RuntimeOrchestrationDatabaseAccess } from '../../orchestration/db/runtime-orchestration-database-access'

export abstract class RuntimeWorkspaceSessionFlush extends RuntimeOrchestrationDatabaseAccess {
  protected async flushWorkspaceSessionOrThrowAsync(): Promise<void> {
    const store = this.store
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
}
