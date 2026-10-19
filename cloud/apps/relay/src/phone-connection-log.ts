import { AssignmentRejectionLogWindow } from './assignment-rejection-log-window.js'
import { relayHostLogDigest } from './relay-host-log-digest.js'

// Phone-connection anomalies that repeat per dial (a stuck database, a lost ledger write, a
// half-open control): per kind, one line opens the window and one closing line carries the rest.
export const PHONE_CONNECTION_LOG_WINDOW_MS = 60_000

export type PhoneDatabaseCause = 'database_transient' | 'error'

// What the cell knew of the desktop's control when a phone's attach deadline passed: a stale
// pong is a half-open control, a fresh one a slow or failing desktop data dial.
export type AttachDeadlineEvidence = {
  credentialKind: 'invite' | 'resume'
  msSinceLastPong: number
  pingOutstanding: boolean
  controlAgeMs: number
  controlRttMs: number | null
  pong: 'stale' | 'fresh'
}

type PhoneConnectionAnomaly =
  | { event: 'orca_relay_client_accept_db_error'; cause: PhoneDatabaseCause }
  | { event: 'orca_relay_client_miss_row_names_here'; relayHostIdDigest: string }
  | { event: 'orca_relay_client_miss_read_error'; cause: PhoneDatabaseCause }
  | { event: 'orca_relay_resume_renewal_failed'; cause: PhoneDatabaseCause }
  | ({ event: 'orca_relay_attach_deadline_offline'; relayHostIdDigest: string } & AttachDeadlineEvidence)
  | { event: 'orca_relay_resume_confirm_failed'; code: string; phonePath: 'db' | 'memory' }

export class PhoneConnectionLog {
  private readonly window: AssignmentRejectionLogWindow<PhoneConnectionAnomaly>

  constructor(
    private readonly cellId: string,
    private readonly warn: (line: string) => void = (line) => console.warn(line),
    schedule?: (callback: () => void, delayMs: number) => () => void
  ) {
    this.window = new AssignmentRejectionLogWindow<PhoneConnectionAnomaly>({
      windowMs: PHONE_CONNECTION_LOG_WINDOW_MS,
      onWindowClosed: ({ suppressed, sample }) => this.write(sample, suppressed),
      schedule
    })
  }

  // The one device read failed; the phone was closed 4503 and never took the invite path.
  databaseError(cause: PhoneDatabaseCause): void {
    this.record(cause, { event: 'orca_relay_client_accept_db_error', cause })
  }

  // No seat, yet the row names this cell: the 4404 may be stale (a lost reserve ledger write).
  missRowNamesHere(relayHostId: string): void {
    this.record('', {
      event: 'orca_relay_client_miss_row_names_here',
      relayHostIdDigest: relayHostLogDigest(relayHostId)
    })
  }

  // The no-seat assignment read failed; the phone was closed 4409 to re-resolve.
  missReadError(cause: PhoneDatabaseCause): void {
    this.record(cause, { event: 'orca_relay_client_miss_read_error', cause })
  }

  // A due renewal write failed; the confirm still answered the stored expiry.
  renewalFailed(cause: PhoneDatabaseCause): void {
    this.record(cause, { event: 'orca_relay_resume_renewal_failed', cause })
  }

  attachDeadline(relayHostId: string, evidence: AttachDeadlineEvidence): void {
    this.record(`${evidence.credentialKind}:${evidence.pong}`, {
      event: 'orca_relay_attach_deadline_offline',
      relayHostIdDigest: relayHostLogDigest(relayHostId),
      ...evidence
    })
  }

  confirmFailed(code: string, phonePath: 'db' | 'memory'): void {
    this.record(`${code}:${phonePath}`, { event: 'orca_relay_resume_confirm_failed', code, phonePath })
  }

  private record(kind: string, anomaly: PhoneConnectionAnomaly): void {
    if (this.window.admit(`${anomaly.event}:${kind}`, anomaly)) this.write(anomaly, 0)
  }

  private write(anomaly: PhoneConnectionAnomaly, suppressed: number): void {
    this.warn(JSON.stringify({ ...anomaly, cellId: this.cellId, ...(suppressed > 0 ? { suppressed } : {}) }))
  }
}
