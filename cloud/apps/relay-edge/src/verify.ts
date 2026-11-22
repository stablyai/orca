// The director's phone credential check (POST /__admin/verify), on the host's own store. Read-only:
// it never freezes, fences or marks the host busy. Devices paired or rotated on the edge, and its
// invites, are only in this object; Postgres gets the devices back when the host leaves.
import { RelayCredentialStore } from '../../relay/src/credentials/credential-store'
import type { VerifyBody, VerifyResult } from './admin'
import type { ObjectStore } from './object-store'

// Whether this object answers for the host at all: only its current placement here, not frozen.
export function verifiesHere(store: ObjectStore, cellId: string, relayHostId: string): boolean {
  const assignment = store.assignment()
  return assignment !== null && assignment.relayHostId === relayHostId && assignment.cellId === cellId && !store.frozen()
}

export async function verifyCredential(store: ObjectStore, cellId: string, body: VerifyBody): Promise<VerifyResult> {
  const assignment = store.assignment()
  if (!assignment || !verifiesHere(store, cellId, body.relayHostId)) { return { outcome: 'not_here' } }
  const credentials = new RelayCredentialStore(store.database)
  const found =
    body.kind === 'invite'
      ? await credentials.resolveInviteForMoveHash(body.relayHostId, body.tokenHash)
      : await credentials.resolveResumeHash(body.relayHostId, body.tokenHash)
  if (!found || found.userId !== assignment.userId) { return { outcome: 'none' } }
  return { outcome: 'verified', userId: found.userId, relayDeviceId: found.relayDeviceId, assignmentEpoch: assignment.assignmentEpoch }
}
