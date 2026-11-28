import { recoverRexRetirement } from './rex-retirement-recovery'
import { RexControl } from './rex-control'
import { RexSnapshotPtyProvider } from './rex-snapshot-pty-provider'
import type { RexFreshSession } from './rex-fresh-session'
import { reclaimExitedRexRecord } from './rex-exit-reclamation'

export class RexReclaimingPtyProvider extends RexSnapshotPtyProvider {
  private readonly reclaims = new Map<string, Promise<boolean>>()
  private reclaimTail: Promise<unknown> = Promise.resolve()

  protected scheduleExitedSession(id: string): void {
    const session = this.sessions.get(id)
    if (!session || session.exitCode === undefined || session.closing || this.reclaims.has(id)) {
      return
    }
    const current = () => this.sessions.get(id) === session && !session.closing
    const work = this.reclaimTail
      .then(async () => {
        if (!current()) {
          return false
        }
        if (!(await reclaimExitedRexRecord(this.socketPath, this.store, session.record, current))) {
          return false
        }
        // Drop only Orca's attachment; the independent Rex client's history remains.
        if (current()) {
          await this.detach(id).catch(() => {})
        }
        return true
      })
      .catch(() => false)
    this.reclaims.set(id, work)
    this.reclaimTail = work
    void work.finally(() => {
      if (this.reclaims.get(id) === work) {
        this.reclaims.delete(id)
      }
    })
  }

  protected override onNaturalExit(session: RexFreshSession): void {
    this.scheduleExitedSession(session.id)
  }

  protected pendingExitReclaim(id: string): Promise<boolean> | undefined {
    return this.reclaims.get(id)
  }

  protected async reclaimCapacity(): Promise<void> {
    if (!(await this.store.atCapacity())) {
      return
    }
    await this.reclaimTail
    if (!(await this.store.atCapacity())) {
      return
    }
    // Bounded pressure scan, not polling or automatic mutation of any native block.
    const records = await this.store.list()
    const deadline = Date.now() + 8000
    for (const record of records) {
      if (Date.now() >= deadline || !(await this.store.atCapacity())) {
        return
      }
      if (this.sessions.has(record.id)) {
        this.scheduleExitedSession(record.id)
        await this.pendingExitReclaim(record.id)
      } else {
        const pending = await this.store.retirements.read(record)
        if (pending) {
          const control = await RexControl.connect(this.socketPath)
          const timer = setTimeout(() => control.close(), 5000)
          try {
            await recoverRexRetirement(control, this.store, record, deadline).catch(() => false)
          } finally {
            clearTimeout(timer)
            control.close()
          }
          continue
        }
        await reclaimExitedRexRecord(
          this.socketPath,
          this.store,
          record,
          () => !this.sessions.has(record.id) && !this.restoring.has(record.id)
        ).catch(() => false)
      }
    }
  }
}
