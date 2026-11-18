// HostRelay RPCs for the edge-native director endpoints (director.ts; dark, see director-config.ts).
// Object backend only: the object's own assignment and credential tables are the answer.
import type { VerifyBody } from './admin'
import { planDirectorAssign, type DirectorAsk } from './director-assign'
import { HostRelayPhones } from './host-relay-phones'
import { verifiesHere, verifyCredential } from './verify'
import { directorConfig } from './director-config'
import { metric } from './metrics'
import { USER_INDEX_PENDING_KEY, afterFailure, mergePending, userIndexOps, type UserIndexOp, type UserIndexPending } from './user-index'

// The cell URL the director endpoints last handed out for this host (object KV, so no schema
// change; an erasure or sweep deletes it with everything else).
export const DIRECTOR_URL_KEY = 'directorCellUrl'

export type DirectorAssignAnswer =
  | { outcome: 'assigned'; cellUrl: string; assignmentEpoch: number }
  | { outcome: 'frozen' | 'elsewhere' | 'unavailable' }
export type DirectorVerifyAnswer = { outcome: 'verified'; cellUrl: string; assignmentEpoch: number } | { outcome: 'none' | 'not_here' }

export abstract class HostRelayDirector extends HostRelayPhones {
  // POST /v1/assign: the Worker verified the relay JWT and that it names this host.
  async directorAssign(ask: DirectorAsk): Promise<DirectorAssignAnswer> {
    if (this.config.backend !== 'object') { return { outcome: 'unavailable' } }
    const cellId = this.config.cellId
    const handedUrl = await this.ctx.storage.get<string>(DIRECTOR_URL_KEY)
    const current = this.store.assignment()
    const plan = planDirectorAssign({ current, handedUrl, frozen: this.store.frozen(), cellId, ask })
    if (plan.outcome !== 'assign') { return { outcome: plan.outcome } }
    // Erasure index (user-index.ts): the first director-native answer for this host (a new
    // object, or a row a legacy push left) and an account switch. Queued before the assignment
    // is written, so an interrupted assign can leave an extra entry but never a missing one; the
    // alarm sends it, never this request.
    if (handedUrl === undefined || current?.userId !== ask.userId) {
      await this.queueUserIndex(ask.relayHostId, userIndexOps(ask.userId, current?.userId ?? null))
    }
    if (plan.write) {
      const { userId, relayHostId } = ask
      const result = await this.store.applyAssignment({
        userId,
        relayHostId,
        cellId,
        assignmentEpoch: plan.assignmentEpoch,
        ...(plan.write.wipe ? { devices: [] } : {})
      })
      if (result.outcome !== 'applied') { return { outcome: 'unavailable' } }
    }
    if (handedUrl !== ask.cellUrl) { await this.ctx.storage.put(DIRECTOR_URL_KEY, ask.cellUrl) }
    // Arms the daily sweep on a newly placed object (and the index write's first attempt).
    await this.reschedule()
    return { outcome: 'assigned', cellUrl: ask.cellUrl, assignmentEpoch: plan.assignmentEpoch }
  }

  // POST /v1/resolve (kind 'resume') and the invite move (kind 'invite'): read-only. An object that
  // never held a host answers before any schema is created (pushed() reads sqlite_master).
  async directorVerify(body: VerifyBody, fallbackCellUrl: string): Promise<DirectorVerifyAnswer> {
    const cellId = this.config.cellId
    if (this.config.backend !== 'object' || !this.pushed() || !verifiesHere(this.store, cellId, body.relayHostId)) {
      return { outcome: 'not_here' }
    }
    const result = await verifyCredential(this.store, cellId, body)
    if (result.outcome !== 'verified') { return result }
    const cellUrl = (await this.ctx.storage.get<string>(DIRECTOR_URL_KEY)) ?? fallbackCellUrl
    return { outcome: 'verified', cellUrl, assignmentEpoch: result.assignmentEpoch }
  }

  // Off unless the director endpoints are configured: production writes nothing.
  private async queueUserIndex(relayHostId: string, ops: Record<string, UserIndexOp>): Promise<void> {
    if (!directorConfig(this.env)) { return }
    const pending = await this.ctx.storage.get<UserIndexPending>(USER_INDEX_PENDING_KEY)
    await this.ctx.storage.put(USER_INDEX_PENDING_KEY, mergePending(pending, relayHostId, ops, Date.now()))
  }

  // From the alarm: sends what is pending and due; keeps what the index did not acknowledge.
  // Director off: nothing is read (a marker left from a time it was on waits for it).
  // Other events can run while the calls are out, so the marker is read again before the update
  // and an op queued meanwhile is never dropped.
  protected async flushUserIndex(now: number): Promise<void> {
    if (!directorConfig(this.env)) { return }
    const pending = await this.ctx.storage.get<UserIndexPending>(USER_INDEX_PENDING_KEY)
    if (!pending || pending.retryAt > now) { return }
    const namespace = this.env.USER_HOSTS
    const acked: Record<string, UserIndexOp> = {}
    for (const [userId, op] of Object.entries(pending.ops)) {
      if (!namespace) { break }
      try {
        const index = namespace.get(namespace.idFromName(userId))
        if (op === 'add') { await index.add(pending.relayHostId) }
        else { await index.remove(pending.relayHostId) }
        acked[userId] = op
      } catch {
        // Retried below.
      }
    }
    const failed = Object.entries(pending.ops).some(([userId, op]) => acked[userId] !== op)
    metric(this.env, 'user_index', 1, failed ? (namespace ? 'retry' : 'unbound') : 'ok')
    const latest = await this.ctx.storage.get<UserIndexPending>(USER_INDEX_PENDING_KEY)
    if (!latest) { return }
    const remaining = Object.fromEntries(Object.entries(latest.ops).filter(([userId, op]) => latest.relayHostId !== pending.relayHostId || acked[userId] !== op))
    if (Object.keys(remaining).length === 0) {
      await this.ctx.storage.delete(USER_INDEX_PENDING_KEY)
      return
    }
    await this.ctx.storage.put(USER_INDEX_PENDING_KEY, failed ? afterFailure(latest, remaining, now) : { ...latest, ops: remaining })
  }
}
