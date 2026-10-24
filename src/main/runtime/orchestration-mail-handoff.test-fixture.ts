import { randomUUID } from 'node:crypto'
import type { MessageRow, MessageType } from './orchestration/types'
import { readMailHandoff, type AutomaticMailHandoff } from './orchestration/mail-handoff'
import type { InMemoryMessageQueue } from './orca-runtime-test-orchestration-messages.spec'

export type MailHandoffQueue = InMemoryMessageQueue & {
  readonly rows: MessageRow[]
  getMessageById(id: string): MessageRow | undefined
  mailboxHandoffAuthority(mailbox: string): string
  getAutomaticMailCandidates(
    mailbox: string,
    options: { afterSequence: number; excludeTypes: readonly string[]; limit: number }
  ): MessageRow[]
  reserveMailHandoff(
    mailbox: string,
    snapshot: MessageRow,
    reference: AutomaticMailHandoff,
    recovery: boolean
  ): MessageRow | undefined
  isMailHandoffCurrent(
    mailbox: string,
    snapshots: readonly MessageRow[],
    authority: string
  ): boolean
  recordMailHandoff(
    mailbox: string,
    snapshots: readonly MessageRow[],
    reference: AutomaticMailHandoff
  ): void
  recordUnknownMailRead(snapshots: readonly MessageRow[]): void
  getOpenMailHandoffHandles(): string[]
  getActiveDispatchForTerminal(): undefined
  markMailboxPointerWriteAttempted(
    ids: string[],
    target: { ptyId: string; processIncarnation: string },
    refusedEnter?: boolean
  ): boolean
}

export type MailHandoffQueueConstructor = new () => MailHandoffQueue

/** Adds handoff ownership while retaining the queue's message and transport lifecycle. */
export function withMailHandoffs(Queue: typeof InMemoryMessageQueue): MailHandoffQueueConstructor {
  return class extends Queue {
    get rows(): MessageRow[] {
      return this.messages
    }

    override insertMessage(
      input: Parameters<InMemoryMessageQueue['insertMessage']>[0]
    ): MessageRow {
      const row = super.insertMessage(input)
      row.delivery_contract = 'current_delivery'
      return row
    }

    override getUndeliveredUnreadMessages(
      toHandle: string,
      types?: MessageType[],
      options?: { excludeTypes?: readonly string[]; limit?: number }
    ): MessageRow[] {
      const rows = super
        .getUndeliveredUnreadMessages(toHandle, types, {
          ...options,
          limit: undefined
        })
        .filter((message) => !message.handoff)
      return options?.limit === undefined ? rows : rows.slice(0, Math.max(1, options.limit))
    }

    override markAsDelivered(ids: string[], mailbox: string): void {
      const selected = new Set(
        this.rows
          .filter((row) => ids.includes(row.id) && row.to_handle === mailbox)
          .map((row) => row.id)
      )
      super.markAsDelivered(ids, mailbox)
      this.offerMailHandoffs(selected)
    }

    override settleMailboxPointerEnter(
      ids: string[],
      target: { ptyId: string; processIncarnation: string },
      expectedPhases: readonly number[]
    ): void {
      const selected = new Set(
        this.rows
          .filter(
            (row) =>
              ids.includes(row.id) &&
              expectedPhases.includes(row.pointer_enter_pending ?? 0) &&
              row.pointer_pty_id === target.ptyId &&
              row.pointer_process_incarnation === target.processIncarnation
          )
          .map((row) => row.id)
      )
      super.settleMailboxPointerEnter(ids, target, expectedPhases)
      this.offerMailHandoffs(selected)
    }

    override releasePendingMailboxPointerForPty(ptyId: string): void {
      this.retireWrittenMailHandoffs(ptyId)
      super.releasePendingMailboxPointerForPty(ptyId)
    }

    override markMailboxPointerWriteAttempted(
      ids: string[],
      target: { ptyId: string; processIncarnation: string },
      refusedEnter = false
    ): boolean {
      if (!refusedEnter) {
        return super.markMailboxPointerWriteAttempted(ids, target)
      }
      const selected = new Set(ids)
      const rows = this.rows.filter(
        (row) =>
          selected.has(row.id) &&
          row.read === 0 &&
          row.pointer_enter_pending === 3 &&
          row.pointer_pty_id === target.ptyId &&
          row.pointer_process_incarnation === target.processIncarnation
      )
      if (rows.length !== ids.length) {
        return false
      }
      for (const row of rows) {
        row.pointer_enter_pending = 2
      }
      return true
    }

    getMessageById(id: string): MessageRow | undefined {
      const row = this.rows.find((message) => message.id === id)
      return row ? { ...row } : undefined
    }

    mailboxHandoffAuthority(mailbox: string): string {
      if (mailbox.startsWith('dispatch:')) {
        return ''
      }
      if (!mailbox.startsWith('run:')) {
        return mailbox
      }
      const run = this.getRun(mailbox.slice(4))
      return run && (run.coordinator_handle || run.coordinator_pane_key)
        ? JSON.stringify(['run', run])
        : ''
    }

    getAutomaticMailCandidates(
      mailbox: string,
      options: { afterSequence: number; excludeTypes: readonly string[]; limit: number }
    ): MessageRow[] {
      return this.rows
        .filter((message) => {
          const handoff = readMailHandoff(message.handoff)
          return (
            message.to_handle === mailbox &&
            message.read === 0 &&
            message.delivery_contract === 'current_delivery' &&
            !message.pointer_enter_pending &&
            message.sequence > options.afterSequence &&
            !options.excludeTypes.includes(message.type) &&
            (!handoff ||
              (handoff.kind !== 'unknown' &&
                (!message.recovery_used || handoff.phase === 'reserved')))
          )
        })
        .sort((a, b) => a.sequence - b.sequence)
        .slice(0, options.limit)
        .map((message) => ({ ...message }))
    }

    reserveMailHandoff(
      mailbox: string,
      snapshot: MessageRow,
      reference: AutomaticMailHandoff,
      recovery: boolean
    ): MessageRow | undefined {
      const row = this.rows.find((message) => message.id === snapshot.id)
      if (
        !row ||
        !this.isMailHandoffCurrent(mailbox, [snapshot], reference.authority) ||
        row.pointer_enter_pending ||
        (recovery && row.recovery_used)
      ) {
        return undefined
      }
      row.handoff = JSON.stringify(reference)
      if (recovery) {
        row.recovery_used = 1
      }
      return { ...row }
    }

    isMailHandoffCurrent(
      mailbox: string,
      snapshots: readonly MessageRow[],
      authority: string
    ): boolean {
      return (
        !!authority &&
        this.mailboxHandoffAuthority(mailbox) === authority &&
        snapshots.every((snapshot) =>
          this.rows.some(
            (row) =>
              row.id === snapshot.id &&
              row.to_handle === mailbox &&
              row.read === 0 &&
              row.delivery_contract === 'current_delivery' &&
              (row.handoff ?? null) === (snapshot.handoff ?? null)
          )
        )
      )
    }

    recordMailHandoff(
      mailbox: string,
      snapshots: readonly MessageRow[],
      reference: AutomaticMailHandoff
    ): void {
      for (const snapshot of snapshots) {
        if (!this.isMailHandoffCurrent(mailbox, [snapshot], reference.authority)) {
          continue
        }
        const row = this.rows.find((message) => message.id === snapshot.id)
        if (!row) {
          continue
        }
        row.handoff = JSON.stringify(reference)
        if (reference.phase === 'offered') {
          row.delivered_at ??= '1970-01-01 00:00:00'
        }
      }
    }

    protected offerMailHandoffs(ids: ReadonlySet<string>): void {
      for (const row of this.rows) {
        if (!ids.has(row.id)) {
          continue
        }
        const reference = readMailHandoff(row.handoff)
        row.handoff =
          reference?.kind === 'terminal'
            ? JSON.stringify({ ...reference, phase: 'offered' })
            : (row.handoff ?? JSON.stringify({ version: 1, kind: 'unknown' }))
      }
    }

    protected retireWrittenMailHandoffs(ptyId: string): void {
      for (const row of this.rows) {
        if (row.pointer_pty_id !== ptyId || row.pointer_enter_pending !== 2) {
          continue
        }
        row.handoff = JSON.stringify({ version: 1, kind: 'unknown' })
        if (row.read === 0) {
          row.delivered_at = null
        }
        row.pointer_enter_pending = 0
        row.pointer_pty_id = null
        row.pointer_process_incarnation = null
      }
    }

    recordUnknownMailRead(snapshots: readonly MessageRow[]): void {
      for (const snapshot of snapshots) {
        const row = this.rows.find((message) => message.id === snapshot.id && message.read === 0)
        if (!row) {
          continue
        }
        row.handoff = JSON.stringify({ version: 1, kind: 'unknown', id: randomUUID() })
        row.pointer_enter_pending = 0
        row.pointer_pty_id = null
        row.pointer_process_incarnation = null
      }
    }

    getOpenMailHandoffHandles(): string[] {
      return [
        ...new Set(
          this.rows
            .filter((message) => {
              const reference = readMailHandoff(message.handoff)
              return (
                message.read === 0 &&
                message.delivery_contract === 'current_delivery' &&
                (!!message.pointer_enter_pending ||
                  (!!message.handoff &&
                    (!message.recovery_used ||
                      (reference?.kind !== 'unknown' && reference?.phase === 'reserved'))))
              )
            })
            .map((message) => message.to_handle)
        )
      ]
    }

    getActiveDispatchForTerminal(): undefined {
      return undefined
    }
  }
}
