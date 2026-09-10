import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { removeSessionSearchDatabase } from './session-search-schema'
import { SessionSearchStore } from './session-search-store'

/**
 * The index store an indexer currently owns, together with its registration as
 * a transcript consumer.
 *
 * The three have one lifetime between them, which is why they are one object.
 * A store closed while still registered is handed reads it cannot take; a
 * registration that outlives its store is how work queued before a `close()`
 * ends up indexing into a database nobody asked for; and a removal owed but not
 * performed is a caller told their history was thrown away while it is still on
 * disk.
 */
export class SessionSearchRegisteredStore {
  private store: SessionSearchStore | null = null
  private unregister: (() => void) | null = null
  private removalOwed = false

  constructor(
    private readonly databasePath: string,
    private readonly onError: (error: unknown) => void
  ) {}

  get current(): SessionSearchStore | null {
    return this.store
  }

  open(cutoffMs: number | null, acceptingWrites: boolean): SessionSearchStore {
    const store = new SessionSearchStore(this.databasePath, this.onError)
    store.setRetentionCutoffMs(cutoffMs)
    store.setAcceptingWrites(acceptingWrites)
    this.store = store
    this.unregister = registerSessionSearchIndexConsumer(store)
    return store
  }

  /** A removal has been asked for; whoever performs it settles the debt. */
  requestRemoval(): void {
    this.removalOwed = true
  }

  /** Closes, then removes the database if one was still owed. */
  close(): void {
    this.unregister?.()
    this.unregister = null
    this.store?.close()
    this.store = null
    if (this.removalOwed) {
      this.removalOwed = false
      removeSessionSearchDatabase(this.databasePath)
    }
  }
}
