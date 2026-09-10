import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { SessionSearchStore } from './session-search-store'

/**
 * The index store an indexer currently owns, together with its registration as
 * a transcript consumer.
 *
 * The two have one lifetime between them, which is why they are one object. A
 * store closed while still registered is handed reads it cannot take; a
 * registration that outlives its store is how work queued before a `close()`
 * ends up indexing into a database nobody asked for.
 */
export class SessionSearchRegisteredStore {
  private store: SessionSearchStore | null = null
  private unregister: (() => void) | null = null

  get current(): SessionSearchStore | null {
    return this.store
  }

  open(args: {
    databasePath: string
    onError: (error: unknown) => void
    cutoffMs: number | null
    acceptingWrites: boolean
  }): SessionSearchStore {
    const store = new SessionSearchStore(args.databasePath, args.onError)
    store.setRetentionCutoffMs(args.cutoffMs)
    store.setAcceptingWrites(args.acceptingWrites)
    this.store = store
    this.unregister = registerSessionSearchIndexConsumer(store)
    return store
  }

  close(): void {
    this.unregister?.()
    this.unregister = null
    this.store?.close()
    this.store = null
  }
}
