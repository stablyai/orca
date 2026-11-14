import type { Store } from '../../persistence/loading-store/store'
import { beginProfileShutdownCheckpoint } from '../../persistence/profile-shutdown-checkpoint'
import { flushOrcadProfileStoreForShutdown } from '../host-lifecycle/orcad-lifecycle'

/** Capture acquired profile resources even when activation fails before runtime construction. */
export class OrcadProfileShutdown {
  store?: Pick<Store, 'flushPendingOrThrowAsync' | 'flushFinalOrThrowAsync' | 'freezeWritesAsync'>
  paneGrids?: { flushPaneGrids(): Promise<void> | null }

  private checkpointing?: Promise<void>

  readonly checkpoint = (): Promise<void> =>
    (this.checkpointing ??= beginProfileShutdownCheckpoint(
      this.store,
      this.paneGrids?.flushPaneGrids()
    ))

  readonly finalize = async (): Promise<void> => {
    await this.checkpointing?.catch(() => {})
    if (this.store) {
      await flushOrcadProfileStoreForShutdown(this.store, this.paneGrids)
    }
  }
}
