import { JournalReaders, type JournalReadLease } from './journal-readers'
import { JournalSqlOwner } from './journal-sql-owner'

/** The native service owns admission; this object owns all physical handles and observed exits. */
export class JournalNativeStorage {
  private readers: JournalReaders
  private preparations: JournalReaders
  onFault: (error: Error) => void = () => {}

  private constructor(
    readonly filename: string,
    private owner: JournalSqlOwner,
    readonly readOnly: boolean,
    private readonly workerPath?: string
  ) {
    this.readers = new JournalReaders(filename, 3, workerPath)
    this.preparations = new JournalReaders(filename, 1, workerPath)
    owner.onFault = (error) => this.onFault(error)
  }

  static async open(filename: string, workerPath?: string): Promise<JournalNativeStorage> {
    const owner = new JournalSqlOwner(filename, { workerPath })
    try {
      return new JournalNativeStorage(filename, owner, await owner.opened(), workerPath)
    } catch (error) {
      await owner.close()
      throw error
    }
  }

  get writer(): JournalSqlOwner {
    return this.owner
  }

  /** Acquire only inside native admission, so a queued prime cannot hold up a preceding drain. */
  snapshot(preparation = false): Promise<JournalReadLease> {
    return (preparation ? this.preparations : this.readers).acquire()
  }

  async close(): Promise<void> {
    const readers = await Promise.allSettled([this.readers.close(), this.preparations.close()])
    const failures = readers.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    try {
      await this.owner.close()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length) {
      throw new AggregateError(failures, 'Native journal handles failed to close')
    }
  }

  /** Called by the same admitted joint job after its profile owner has detached the journal. */
  async reopen(): Promise<void> {
    const owner = new JournalSqlOwner(this.filename, { workerPath: this.workerPath })
    try {
      if ((await owner.opened()) !== this.readOnly) {
        throw new Error('Native journal write availability changed during maintenance')
      }
    } catch (error) {
      await owner.close()
      throw error
    }
    this.owner = owner
    owner.onFault = (error) => this.onFault(error)
    this.readers = new JournalReaders(this.filename, 3, this.workerPath)
    this.preparations = new JournalReaders(this.filename, 1, this.workerPath)
  }
}
