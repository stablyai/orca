import { POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES } from '../../db/federation/remote-attachment-liveness'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { mailWakeObligation } from '../../../../../shared/agent-session/lifecycle/mail-wake-obligation'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from '../terminal-pointer/mailbox-pointer-eligibility'

export function mailboxOwnerPane(db: OrchestrationDb, mailbox: string): string | null {
  if (mailbox.startsWith('run:')) {
    return db.getRun(mailbox.slice(4))?.coordinator_pane_key ?? null
  }
  if (mailbox.startsWith('dispatch:')) {
    const id = mailbox.slice(9)
    const dispatch = db.getDispatchContextById(id)
    if (dispatch) {
      return dispatch.status === 'pending' || dispatch.status === 'dispatched'
        ? dispatch.assignee_pane_key
        : null
    }
    const attachment = db.getRemoteDispatchAttachment(id)
    return attachment &&
      POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES.some((state) => state === attachment.state)
      ? attachment.pane_key
      : null
  }
  return null
}

type WakeDeps = {
  db: () => OrchestrationDb | null
  record: (paneKey: string) => SleepingAgentSessionRecord | null
  waiters: (mailbox: string) => ReadonlySet<OrchestrationMessageWaiter> | undefined
  prepare: (record: SleepingAgentSessionRecord) => Promise<void>
  wake: (record: SleepingAgentSessionRecord) => Promise<boolean>
}

/** Durable mail derives the obligation; only a proven wake suppresses the same unconsumed batch. */
export class SleptMailboxWake {
  private readonly pending = new Map<
    string,
    { mailbox: string; reservedTypes?: ReadonlySet<string> }
  >()
  private readonly inFlight = new Map<string, number>()
  private readonly succeeded = new Map<string, { paneKey: string; sequence: number }>()
  private readonly failed = new Map<string, number>()
  private active = 0

  constructor(private readonly deps: WakeDeps) {}

  failedToWake(record: SleepingAgentSessionRecord): boolean {
    return this.failed.get(record.paneKey) === record.capturedAt
  }

  batch(mailbox: string, reservedTypes?: ReadonlySet<string>) {
    const db = this.deps.db()
    const paneKey = db ? mailboxOwnerPane(db, mailbox) : null
    const record = paneKey ? this.deps.record(paneKey) : null
    if (!db || !record || !mailWakeObligation(record)) {
      return null
    }
    const messages = selectOrchestrationPointerBatch({
      db,
      mailboxHandle: mailbox,
      waiters: this.deps.waiters(mailbox),
      reservedTypes,
      newestFirst: true
    }).messages
    const sequence = messages[0]?.sequence
    return sequence === undefined ? null : { record, sequence }
  }

  owesPane(paneKey: string): boolean {
    return (this.deps.db()?.getUndeliveredUnreadMailboxHandles() ?? []).some(
      (mailbox) => this.batch(mailbox)?.record.paneKey === paneKey
    )
  }

  request(mailbox: string, reservedTypes?: ReadonlySet<string>): void {
    const batch = this.batch(mailbox, reservedTypes)
    if (
      !batch ||
      mailWakeObligation(batch.record) === 'manual' ||
      (this.succeeded.get(mailbox)?.paneKey === batch.record.paneKey &&
        this.succeeded.get(mailbox)?.sequence === batch.sequence)
    ) {
      return
    }
    const paneKey = batch.record.paneKey
    if (this.inFlight.get(paneKey) === batch.sequence) {
      return
    }
    this.pending.set(paneKey, { mailbox, reservedTypes })
    this.drain()
  }

  private drain(): void {
    while (this.active < 2 && this.pending.size) {
      const next = [...this.pending].find(([paneKey]) => !this.inFlight.has(paneKey))
      if (!next) {
        return
      }
      const [paneKey, request] = next
      this.pending.delete(paneKey)
      this.inFlight.set(paneKey, this.batch(request.mailbox, request.reservedTypes)?.sequence ?? -1)
      this.active++
      void this.run(request.mailbox, request.reservedTypes)
        .catch(() => undefined)
        .finally(() => {
          this.inFlight.delete(paneKey)
          this.active--
          this.drain()
        })
    }
  }

  private async run(mailbox: string, reservedTypes?: ReadonlySet<string>): Promise<void> {
    const before = this.batch(mailbox, reservedTypes)
    if (
      !before ||
      mailWakeObligation(before.record) === 'manual' ||
      (this.succeeded.get(mailbox)?.paneKey === before.record.paneKey &&
        this.succeeded.get(mailbox)?.sequence === before.sequence)
    ) {
      return
    }
    await this.deps.prepare(before.record)
    const current = this.batch(mailbox, reservedTypes)
    if (
      !current ||
      current.record.paneKey !== before.record.paneKey ||
      mailWakeObligation(current.record) === 'manual'
    ) {
      return
    }
    if (await this.deps.wake(current.record).catch(() => false)) {
      this.failed.delete(current.record.paneKey)
      this.succeeded.set(mailbox, { paneKey: current.record.paneKey, sequence: current.sequence })
    } else {
      this.failed.set(current.record.paneKey, current.record.capturedAt)
    }
  }
}
