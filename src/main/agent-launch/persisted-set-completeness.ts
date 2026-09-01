// Shared by the durable launch stores: a boot that could not READ its persisted
// state (locked keychain, EACCES/EBUSY file) holds an intact set on disk while
// memory sees nothing. Callers that must reason about the FULL set — tombstone
// retention — have to stay conservative until a recovery merge lands, which they
// cannot do unless the store says its view is partial.

export class PersistedSetCompleteness {
  private complete = true

  markIncomplete(): void {
    this.complete = false
  }

  markComplete(): void {
    this.complete = true
  }

  /** True when the in-memory entries are the whole persisted set. */
  isComplete(): boolean {
    return this.complete
  }
}
