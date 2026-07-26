import { admittedSshAppPtyIdBytes } from './ssh-pty-wire-admission'

export const MAX_SSH_PTY_LIVE_ROSTER_ENTRIES = 256
export const MAX_SSH_PTY_LIVE_ROSTER_ID_BYTES = 2 * 1024 * 1024

export type SshPtyListingToken = {
  sequence: number
  observationRevision: number
}

type RosterEntry = {
  idBytes: number
  live: boolean
  missingListingGrace: boolean
  observationRevision: number
}

export class SshPtyLiveRoster {
  private readonly entries = new Map<string, RosterEntry>()
  private observationRevision = 0
  private listingSequence = 0
  private latestReconciledListing = 0
  private retainedIdBytes = 0
  private staleListingFenceRevision = 0

  beginListing(): SshPtyListingToken {
    return {
      sequence: ++this.listingSequence,
      observationRevision: this.observationRevision
    }
  }

  recordSpawn(id: string): void {
    this.record(id, true)
  }

  recordNotification(id: string): void {
    this.record(id, false)
  }

  recordExit(id: string): void {
    const idBytes = admittedSshAppPtyIdBytes(id)
    if (idBytes === null) {
      return
    }
    this.setEntry(id, {
      idBytes,
      live: false,
      missingListingGrace: false,
      observationRevision: ++this.observationRevision
    })
  }

  reconcileListing(token: SshPtyListingToken, listedIds: readonly string[]): void {
    if (token.sequence <= this.latestReconciledListing) {
      return
    }
    this.latestReconciledListing = token.sequence
    if (token.observationRevision < this.staleListingFenceRevision) {
      return
    }
    const listed = new Set<string>()
    for (const id of listedIds) {
      if (listed.size < MAX_SSH_PTY_LIVE_ROSTER_ENTRIES && admittedSshAppPtyIdBytes(id) !== null) {
        listed.add(id)
      }
    }

    for (const [id, entry] of this.entries) {
      if (!entry.live || listed.has(id) || entry.observationRevision > token.observationRevision) {
        continue
      }
      if (entry.missingListingGrace) {
        entry.missingListingGrace = false
        entry.observationRevision = ++this.observationRevision
        continue
      }
      this.removeEntry(id)
    }

    for (const id of listed) {
      const current = this.entries.get(id)
      // Why: an exit newer than this listing request must fence its stale response.
      if (current && !current.live && current.observationRevision > token.observationRevision) {
        continue
      }
      this.record(id, false)
    }
  }

  has(id: string): boolean {
    return this.entries.get(id)?.live === true
  }

  clear(): void {
    this.entries.clear()
    this.retainedIdBytes = 0
    // Why: responses from listings already in flight must not repopulate a disposed provider.
    this.latestReconciledListing = this.listingSequence
  }

  private record(id: string, missingListingGrace: boolean): void {
    const idBytes = admittedSshAppPtyIdBytes(id)
    if (idBytes === null) {
      return
    }
    this.setEntry(id, {
      idBytes,
      live: true,
      missingListingGrace,
      observationRevision: ++this.observationRevision
    })
  }

  private setEntry(id: string, entry: RosterEntry): void {
    this.removeEntry(id)
    this.entries.set(id, entry)
    this.retainedIdBytes += entry.idBytes
    this.capEntries()
  }

  private capEntries(): void {
    while (
      this.entries.size > MAX_SSH_PTY_LIVE_ROSTER_ENTRIES ||
      this.retainedIdBytes > MAX_SSH_PTY_LIVE_ROSTER_ID_BYTES
    ) {
      let inactive: string | undefined
      for (const [id, entry] of this.entries) {
        if (!entry.live) {
          inactive = id
          break
        }
      }
      const oldest = this.entries.keys().next().value as string | undefined
      const evictedId = inactive ?? oldest ?? ''
      const evicted = this.entries.get(evictedId)
      if (evicted && !evicted.live) {
        this.staleListingFenceRevision = Math.max(
          this.staleListingFenceRevision,
          evicted.observationRevision
        )
      }
      this.removeEntry(evictedId)
    }
  }

  private removeEntry(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) {
      return
    }
    this.retainedIdBytes -= entry.idBytes
    this.entries.delete(id)
  }
}
