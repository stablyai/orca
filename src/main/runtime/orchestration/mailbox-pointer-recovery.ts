import type { OrchestrationDb } from './db'
import {
  MAILBOX_POINTER_RESERVED,
  type MailboxPointerReservation
} from './db/messages/mailbox-pointer-enter-state'
import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxPointerState } from './mailbox-pointer-state'

/** Reconciles mailbox pointer reservations this runtime still owns, reading them straight from
 *  the durable rows through `idx_messages_pending_pointer_pty` so no in-memory mirror can drift.
 *  Rows from an earlier process fail the incarnation fence here and are reclaimed instead by the
 *  idle-edge resume path. */
export class MailboxPointerRecovery<TWaiter extends OrchestrationMessageWaiter> {
  private connection?: OrchestrationDb['db']

  constructor(
    private readonly deps: PointerDeliveryDependencies<TWaiter>,
    private readonly state: OrchestrationMailboxPointerState
  ) {}

  attach(db: OrchestrationDb | null): void {
    if (this.connection === db?.db) {
      return
    }
    this.connection = db?.db
    this.state.clear()
    if (!db) {
      return
    }
    try {
      // An already-read row's message is consumed, so its reservation is garbage whether or not
      // the pane that made it still lives; otherwise it leaks in the partial index forever.
      this.reconcile(
        db,
        db.getMailboxPointerReservations().filter((row) => row.read !== 0 || this.isLive(row))
      )
    } catch {
      // Why: attach runs during database construction; a failed sweep must not escape and
      // strand the federation relay started right after it. The next edge retries recovery.
    }
  }

  observeWorking(ptyId: string): void {
    const db = this.deps.getDb()
    this.attach(db)
    if (!db) {
      return
    }
    this.reconcile(
      db,
      db.getMailboxPointerReservationsForPty(ptyId).filter((row) => this.isLive(row))
    )
  }

  settle(ptyId: string, ids: readonly string[], incarnation: string): void {
    const db = this.deps.getDb()
    if (!db || this.connection !== db.db) {
      return
    }
    const selected = new Set(ids)
    this.reconcile(
      db,
      db
        .getMailboxPointerReservationsForPty(ptyId)
        .filter((row) => selected.has(row.id) && row.pointer_process_incarnation === incarnation)
    )
  }

  /** A reservation is only recoverable while the pane still runs the incarnation that made it. */
  private isLive(row: MailboxPointerReservation): boolean {
    try {
      const handle = this.deps.deliveryTarget.resolveTerminalHandle(row.to_handle)
      if (!handle) {
        return false
      }
      const leaf = this.deps.getLiveLeafForHandle(handle)
      return (
        leaf.ptyId === row.pointer_pty_id &&
        this.deps.resolveSubmitTarget(leaf, row.pointer_pty_id)?.processIncarnation ===
          row.pointer_process_incarnation
      )
    } catch {
      // Attach may precede terminal restoration; the next observation retries recovery.
      return false
    }
  }

  private reconcile(db: OrchestrationDb, rows: readonly MailboxPointerReservation[]): void {
    for (const row of rows) {
      // Why: a live flight owns its own settlement; observing it here would also mark it
      // working, licensing a settle for a pane that never produced a working edge.
      if (this.state.hasFlight(row.pointer_pty_id)) {
        continue
      }
      const target = {
        ptyId: row.pointer_pty_id,
        processIncarnation: row.pointer_process_incarnation
      }
      // Why: releasing is gated on `read = 0`, so an already-read row could never clear and
      // would leak in the partial index, re-probing on every later working edge.
      if (row.read === 0 && row.pointer_enter_pending === MAILBOX_POINTER_RESERVED) {
        db.releaseMailboxPointerEnter([row.id], target, [row.pointer_enter_pending])
      } else {
        db.settleMailboxPointerEnter([row.id], target, [row.pointer_enter_pending])
      }
    }
  }
}
