// The director's phone credential check (POST /__admin/verify), on the host's own store. Read-only:
// it never freezes, fences or marks the host busy. Devices paired or rotated on the edge, and its
// invites, are only in this object; Postgres gets the devices back when the host leaves.
import { RelayCredentialStore } from '../../relay/src/credential-store'
import type { VerifyBody, VerifyResult } from './admin'
import type { ObjectStore } from './object-store'

// Answers only for the host's current placement here: a moved-away or frozen object says not_here.
export async function verifyCredential(store: ObjectStore, cellId: string, body: VerifyBody): Promise<VerifyResult> {
  const assignment = store.assignment()
  if (!assignment || assignment.relayHostId !== body.relayHostId || assignment.cellId !== cellId || store.frozen()) {
    return { outcome: 'not_here' }
  }
  const credentials = new RelayCredentialStore(store.database)
  const found =
    body.kind === 'invite'
      ? await credentials.resolveInviteForMoveHash(body.relayHostId, body.tokenHash)
      : await credentials.resolveResumeHash(body.relayHostId, body.tokenHash)
  if (!found || found.userId !== assignment.userId) {
    return { outcome: 'none' }
  }
  return { outcome: 'verified', userId: found.userId, relayDeviceId: found.relayDeviceId, assignmentEpoch: assignment.assignmentEpoch }
}
