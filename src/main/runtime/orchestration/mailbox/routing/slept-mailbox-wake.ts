import { POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES } from '../../db/federation/remote-attachment-liveness'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { mailWakeObligation } from '../../../../../shared/agent-session/lifecycle/mail-wake-obligation'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  selectOrchestrationPointerSequence,
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
  private readonly owed = new Map<string, { paneKey: string; sequence: number }>()
  private readonly byPane = new Map<string, Set<string>>()
  private readonly attempted = new Map<
    string,
    { record: SleepingAgentSessionRecord; sequence: number }
  >()
  private readonly held = new Map<string, string>()
  private readonly workspaceCounts = new Map<string, number>()
  private active = 0

  constructor(private readonly deps: WakeDeps) {}

  failedToWake(record: SleepingAgentSessionRecord): boolean {
    return this.failed.get(record.paneKey) === (record.mailWake?.capturedAt ?? record.capturedAt)
  }

  batch(mailbox: string, reservedTypes?: ReadonlySet<string>) {
    const db = this.deps.db()
    const paneKey = db ? mailboxOwnerPane(db, mailbox) : null
    const record = paneKey ? this.deps.record(paneKey) : null
    if (!db || !record || !mailWakeObligation(record)) {
      return null
    }
    const sequence = this.selection(mailbox, reservedTypes)?.sequence
    return sequence === undefined ? null : { record, sequence }
  }

  private selection(mailbox: string, reservedTypes?: ReadonlySet<string>) {
    const db = this.deps.db()
    const paneKey = db && mailboxOwnerPane(db, mailbox)
    if (!db || !paneKey) {
      return null
    }
    const sequence = selectOrchestrationPointerSequence({
      db,
      mailboxHandle: mailbox,
      waiters: this.deps.waiters(mailbox),
      reservedTypes
    })
    return sequence === undefined ? null : { paneKey, sequence }
  }

  refresh(mailbox: string): string[] {
    const before = this.owed.get(mailbox)
    const next = this.selection(mailbox)
    if (before) {
      const handles = this.byPane.get(before.paneKey)
      handles?.delete(mailbox)
      if (!handles?.size) {
        this.byPane.delete(before.paneKey)
      }
    }
    this.owed.delete(mailbox)
    if (next) {
      this.owed.set(mailbox, next)
      const handles = this.byPane.get(next.paneKey) ?? new Set<string>()
      handles.add(mailbox)
      this.byPane.set(next.paneKey, handles)
    }
    const success = this.succeeded.get(mailbox)
    if (!next || success?.paneKey !== next.paneKey || success.sequence !== next.sequence) {
      this.succeeded.delete(mailbox)
    }
    const attempted = this.attempted.get(mailbox)
    if (!next || (attempted && attempted.record.paneKey !== next.paneKey)) {
      this.attempted.delete(mailbox)
    }
    if (before && !this.byPane.has(before.paneKey)) {
      this.failed.delete(before.paneKey)
    }
    if (before) {
      this.refreshPane(before.paneKey)
    }
    if (next) {
      this.refreshPane(next.paneKey)
    }
    return [...new Set([...(before ? [before.paneKey] : []), ...(next ? [next.paneKey] : [])])]
  }

  get hasTrackedMail(): boolean {
    return this.owed.size > 0 || this.attempted.size > 0
  }

  reconcile(): void {
    const handles = new Set(this.deps.db()?.getUndeliveredUnreadMailboxHandles() ?? [])
    for (const handle of this.owed.keys()) {
      handles.add(handle)
    }
    for (const handle of handles) {
      this.refresh(handle)
    }
  }

  mailboxesForPane(paneKey: string): readonly string[] {
    return [...(this.byPane.get(paneKey) ?? [])]
  }

  owesPane(paneKey: string): boolean {
    for (const mailbox of this.mailboxesForPane(paneKey)) {
      this.refresh(mailbox)
      if (this.batch(mailbox)?.record.paneKey === paneKey) {
        return true
      }
    }
    return false
  }

  refreshPane(paneKey: string): void {
    const previous = this.held.get(paneKey)
    const record = this.deps.record(paneKey)
    const next =
      this.byPane.has(paneKey) && mailWakeObligation(record) ? record?.worktreeId : undefined
    if (previous === next) {
      return
    }
    if (previous) {
      const count = (this.workspaceCounts.get(previous) ?? 1) - 1
      if (count) {
        this.workspaceCounts.set(previous, count)
      } else {
        this.workspaceCounts.delete(previous)
      }
    }
    this.held.delete(paneKey)
    if (next) {
      this.held.set(paneKey, next)
      this.workspaceCounts.set(next, (this.workspaceCounts.get(next) ?? 0) + 1)
    }
    if (!record) {
      this.failed.delete(paneKey)
    }
  }

  heldWorktrees(): string[] {
    return [...this.workspaceCounts.keys()].sort()
  }

  confirmed(record: SleepingAgentSessionRecord): void {
    for (const mailbox of this.mailboxesForPane(record.paneKey)) {
      const attempt = this.attempted.get(mailbox)
      if (
        !attempt ||
        attempt.record.worktreeId !== record.worktreeId ||
        attempt.record.agent !== record.agent ||
        (attempt.record.connectionId ?? null) !== (record.connectionId ?? null) ||
        (attempt.record.mailWake?.capturedAt ?? attempt.record.capturedAt) !==
          record.mailWake?.capturedAt ||
        (attempt.record.mailWake && attempt.record.mailWake.id !== record.mailWake?.id) ||
        !agentProviderSessionsEqual(
          record.agent,
          record.providerSession,
          attempt.record.providerSession
        )
      ) {
        continue
      }
      this.refresh(mailbox)
      if (this.owed.get(mailbox)?.paneKey === record.paneKey) {
        this.succeeded.set(mailbox, { paneKey: record.paneKey, sequence: attempt.sequence })
        this.failed.delete(record.paneKey)
      }
      this.attempted.delete(mailbox)
    }
  }

  request(mailbox: string, reservedTypes?: ReadonlySet<string>): void {
    this.refresh(mailbox)
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
    this.failed.delete(before.record.paneKey)
    await this.deps.prepare(before.record)
    const current = this.batch(mailbox, reservedTypes)
    if (
      !current ||
      current.record.paneKey !== before.record.paneKey ||
      mailWakeObligation(current.record) === 'manual'
    ) {
      return
    }
    this.attempted.set(mailbox, { record: current.record, sequence: current.sequence })
    const succeeded = await this.deps.wake(current.record).catch(() => false)
    this.refresh(mailbox)
    if (this.owed.get(mailbox)?.paneKey !== current.record.paneKey) {
      return
    }
    if (succeeded) {
      if (this.owed.get(mailbox)?.sequence === current.sequence) {
        this.succeeded.set(mailbox, { paneKey: current.record.paneKey, sequence: current.sequence })
      }
      this.failed.delete(current.record.paneKey)
      this.attempted.delete(mailbox)
    } else if (this.deps.record(current.record.paneKey)) {
      this.failed.set(
        current.record.paneKey,
        current.record.mailWake?.capturedAt ?? current.record.capturedAt
      )
    }
  }
}
