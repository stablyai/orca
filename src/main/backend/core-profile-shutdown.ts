import type { Store } from '../persistence/loading-store/store'
import { beginProfileShutdownCheckpoint } from '../persistence/profile-shutdown-checkpoint'
import { flushOrcadProfileStoreForShutdown } from '../orcad/host-lifecycle/orcad-lifecycle'

/** Capture acquired profile resources even when activation fails before runtime construction. */
export class BackendCoreProfileShutdown {
  store?: Pick<Store, 'flushPendingOrThrowAsync' | 'flushFinalOrThrowAsync' | 'freezeWritesAsync'>
  paneGrids?: { flushPaneGrids(): Promise<void> | null }
  /** A restart on a daemon that can't repaint trusts a quiet agent's frame only through this. */
  paintLedger?: { saveReattachedPaintLedger(): Promise<void> }

  private checkpointing?: Promise<void>

  readonly checkpoint = (): Promise<void> =>
    (this.checkpointing ??= beginProfileShutdownCheckpoint(
      this.store,
      this.paneGrids?.flushPaneGrids()
    ))

  readonly finalize = async (): Promise<void> => {
    await this.checkpointing?.catch(() => {})
    // Saved while the daemon is still connected; its disconnect runs after this cleanup.
    const [, flushed] = await Promise.allSettled([
      this.paintLedger?.saveReattachedPaintLedger(),
      this.store ? flushOrcadProfileStoreForShutdown(this.store, this.paneGrids) : undefined
    ])
    if (flushed.status === 'rejected') {
      throw flushed.reason
    }
  }
}
