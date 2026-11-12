import type { PendingOutputRecord } from '../../protocol/daemon-rpc-contract'
import type { ReplayRecordSource } from '../restoration/cold-restore-replay-writer'

/**
 * The sole owner of a reader's frozen pending records. Cuts and continuations keep this handle,
 * never the array or its strings, so revocation severs the backing before its charge ends.
 */
export class RevocablePendingSource {
  private records: PendingOutputRecord[] | null
  private disposeParser: (() => void) | null = null

  constructor(records: PendingOutputRecord[]) {
    this.records = records
  }

  readonly at: ReplayRecordSource = (index) => (this.records ? this.records[index] : null)

  get revoked(): boolean {
    return this.records === null
  }

  /** The replay parser reading this source; revocation disposes it at the yielded boundary. */
  holdParser(dispose: (() => void) | null): void {
    this.disposeParser = this.records ? dispose : null
    if (!this.records) {
      dispose?.()
    }
  }

  revoke(): void {
    this.records = null
    const dispose = this.disposeParser
    this.disposeParser = null
    dispose?.()
  }
}
