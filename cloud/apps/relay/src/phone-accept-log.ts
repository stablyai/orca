import { AssignmentRejectionLogWindow } from './assignment-rejection-log-window.js'
import { relayHostLogDigest } from './relay-host-log-digest.js'

// The memory phone path's two accept anomalies. A stuck database or a lost ledger write repeats
// per phone dial, so per event one line opens the window and one closing line carries the rest.
export const PHONE_ACCEPT_LOG_WINDOW_MS = 60_000

export type PhoneAcceptDatabaseCause = 'database_transient' | 'error'

type PhoneAcceptAnomaly =
  | { event: 'orca_relay_client_accept_db_error'; cause: PhoneAcceptDatabaseCause }
  | { event: 'orca_relay_client_miss_row_names_here'; relayHostIdDigest: string }
  | { event: 'orca_relay_client_miss_read_error'; cause: PhoneAcceptDatabaseCause }
  | { event: 'orca_relay_resume_renewal_failed'; cause: PhoneAcceptDatabaseCause }

export class PhoneAcceptLog {
  private readonly window: AssignmentRejectionLogWindow<PhoneAcceptAnomaly>

  constructor(
    private readonly cellId: string,
    private readonly warn: (line: string) => void = (line) => console.warn(line),
    schedule?: (callback: () => void, delayMs: number) => () => void
  ) {
    this.window = new AssignmentRejectionLogWindow<PhoneAcceptAnomaly>({
      windowMs: PHONE_ACCEPT_LOG_WINDOW_MS,
      onWindowClosed: ({ suppressed, sample }) => this.write(sample, suppressed),
      schedule
    })
  }

  // The one device read failed; the phone was closed 4503 and never took the invite path.
  databaseError(cause: PhoneAcceptDatabaseCause): void {
    this.record({ event: 'orca_relay_client_accept_db_error', cause })
  }

  // No seat, yet the row names this cell: the 4404 may be stale (a lost reserve ledger write).
  missRowNamesHere(relayHostId: string): void {
    this.record({
      event: 'orca_relay_client_miss_row_names_here',
      relayHostIdDigest: relayHostLogDigest(relayHostId)
    })
  }

  // The no-seat assignment read failed; the phone was closed 4409 to re-resolve.
  missReadError(cause: PhoneAcceptDatabaseCause): void {
    this.record({ event: 'orca_relay_client_miss_read_error', cause })
  }

  // A due renewal write failed; the confirm still answered the stored expiry.
  renewalFailed(cause: PhoneAcceptDatabaseCause): void {
    this.record({ event: 'orca_relay_resume_renewal_failed', cause })
  }

  private record(anomaly: PhoneAcceptAnomaly): void {
    if (this.window.admit(anomaly.event, anomaly)) this.write(anomaly, 0)
  }

  private write(anomaly: PhoneAcceptAnomaly, suppressed: number): void {
    this.warn(JSON.stringify({ ...anomaly, cellId: this.cellId, ...(suppressed > 0 ? { suppressed } : {}) }))
  }
}
