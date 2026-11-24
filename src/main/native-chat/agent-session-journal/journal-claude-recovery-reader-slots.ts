import type { ReaderSlot } from './journal-sql-reader-slot'
import type { JournalSqlPointRead } from './journal-sql-point-read'

export class JournalClaudeRecoveryReaderSlots {
  private readonly transfers = new Map<string, ReaderSlot>()

  get active(): boolean {
    return this.transfers.size !== 0
  }

  uses(slot: ReaderSlot): boolean {
    return [...this.transfers.values()].includes(slot)
  }

  async request(request: JournalSqlPointRead, choose: () => ReaderSlot) {
    const { operation } = request
    const transferId =
      operation.kind === 'claude-recovery-slices' || operation.kind === 'claude-recovery-release'
        ? operation.transferId
        : undefined
    const pinned = transferId ? this.transfers.get(transferId) : undefined
    if (operation.kind === 'claude-recovery-release' && !pinned) {
      return { type: 'point' as const, result: { kind: 'claude-recovery-release' as const } }
    }
    // Leave room for the fork and conversion readers when all recoveries are active.
    const active = transferId
      ? [...new Set(this.transfers.values())].filter((slot) => !slot.failed)
      : []
    const slot =
      pinned ??
      (active.length < 2
        ? choose()
        : active.toSorted((a, b) => a.pendingCount - b.pendingCount)[0]!)
    if (transferId) {
      this.transfers.set(transferId, slot)
    }
    if (transferId && operation.kind === 'claude-recovery-release') {
      this.transfers.delete(transferId)
    }
    const response = await slot.request({ kind: 'point', request })
    if (
      transferId &&
      response.type === 'point' &&
      response.result.kind === 'claude-recovery-slices' &&
      !response.result.next
    ) {
      this.transfers.delete(transferId)
    }
    return response
  }
}
