import type { TerminalHistoryImage } from './terminal-session-journal-contract'

/** Aggregate retained derived images host-wide, including invalidated ones still leased. */
export const DERIVED_IMAGE_BUDGET_BYTES = 16 * 1024 * 1024

/** A disposable projection of one journal's latest answer; never a history source. */
export type DerivedHistoryImage = {
  readonly key: string
  /** Cleared before its charge ends, so an uncharged entry keeps no payload reachable. */
  image: TerminalHistoryImage | null
  /** Conservative retained charge: UTF-16 string backing plus link and metadata overhead. */
  readonly charge: number
  leases: number
  eligible: boolean
  /** Clears the owner's pointer when the budget evicts this entry. */
  readonly onEvict: () => void
}

/** A consumer's hold on one image; release drops this wrapper's own reference too. */
export type DerivedImageLease = { readonly image: TerminalHistoryImage | null; release(): void }

export class DerivedHistoryImageBudget {
  private charged = 0
  private readonly entries = new Set<DerivedHistoryImage>()

  constructor(readonly capacity = DERIVED_IMAGE_BUDGET_BYTES) {}

  /** Admits by evicting only unleased entries; false leaves the answer uncached, never trimmed. */
  admit(entry: DerivedHistoryImage): boolean {
    if (entry.charge > this.capacity) {
      return false
    }
    for (const other of this.entries) {
      if (this.charged + entry.charge <= this.capacity) {
        break
      }
      if (other.leases === 0) {
        other.eligible = false
        other.onEvict()
        this.settle(other)
      }
    }
    if (this.charged + entry.charge > this.capacity) {
      return false
    }
    this.entries.add(entry)
    this.charged += entry.charge
    return true
  }

  /** Invalidation removes eligibility at once; payload and charge end with the last lease. */
  settle(entry: DerivedHistoryImage): void {
    if (!entry.eligible && entry.leases === 0 && this.entries.delete(entry)) {
      entry.image = null
      this.charged -= entry.charge
    }
  }

  lease(entry: DerivedHistoryImage): DerivedImageLease {
    let image = entry.image
    if (image) {
      entry.leases += 1
    }
    return {
      get image() {
        return image
      },
      release: () => {
        if (image) {
          image = null
          entry.leases -= 1
          this.settle(entry)
        }
      }
    }
  }
}

export function derivedImageCharge(image: TerminalHistoryImage): number {
  const { snapshot } = image
  const strings = [
    snapshot.snapshotAnsi,
    snapshot.scrollbackAnsi,
    snapshot.rehydrateSequences,
    snapshot.pendingEscapeTailAnsi,
    snapshot.frameRestoreAnsi,
    snapshot.cwd,
    snapshot.lastTitle
  ]
  let units = strings.reduce((sum, text) => sum + (text?.length ?? 0), 0)
  for (const link of snapshot.oscLinks ?? []) {
    units += link.uri.length + 32
  }
  return units * 2 + 1024
}
