// HostRelay RPCs for the edge-native director endpoints (director.ts; dark, see director-config.ts).
// Object backend only: the object's own assignment and credential tables are the answer.
import type { VerifyBody } from './admin'
import { planDirectorAssign, type DirectorAsk } from './director-assign'
import { HostRelayPhones } from './host-relay-phones'
import { verifiesHere, verifyCredential } from './verify'

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
    const plan = planDirectorAssign({ current: this.store.assignment(), handedUrl, frozen: this.store.frozen(), cellId, ask })
    if (plan.outcome !== 'assign') { return { outcome: plan.outcome } }
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
    // Arms the daily sweep on a newly placed object.
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
}
