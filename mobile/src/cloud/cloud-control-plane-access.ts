import { z } from 'zod'
import {
  CloudWorkspaceGrantIssuedSchema,
  SealedGrantSchema
} from '../../../src/shared/cloud-workspaces/cloud-workspaces-wire'
import { OrcaCloudDeviceSessionSchema } from '../../../src/shared/orca-cloud-device-enrollment-contract'
import { cloudRequest as request, type CloudControlPlane } from './cloud-control-plane-request'

// Access: a VM's sealed per-device grant, and this user's device sessions.

export type CloudSealedGrant = z.infer<typeof SealedGrantSchema>

/** Asks the VM for this phone's own orcad device, sealed to a one-time key only this phone holds. */
export async function requestCloudWorkspaceGrant(
  plane: CloudControlPlane,
  sandboxId: string,
  body: { recipientPublicKeyB64: string; deviceLabel: string }
): Promise<{ grantId: string; sealed: CloudSealedGrant }> {
  const reply = await request(
    plane,
    'POST',
    `/v1/team/workspaces/${encodeURIComponent(sandboxId)}/grants`,
    CloudWorkspaceGrantIssuedSchema,
    { body: { ...body, deviceKind: 'mobile' }, timeoutMs: 60_000 }
  )
  return { grantId: reply.grant.id, sealed: reply.sealed }
}

export async function listCloudDeviceSessions(plane: CloudControlPlane) {
  return (
    await request(
      plane,
      'GET',
      '/v1/device-sessions',
      z.object({ deviceSessions: z.array(OrcaCloudDeviceSessionSchema) })
    )
  ).deviceSessions
}

export async function revokeCloudDeviceSession(
  plane: CloudControlPlane,
  id: string
): Promise<void> {
  await request(plane, 'DELETE', `/v1/device-sessions/${encodeURIComponent(id)}`, z.unknown())
}
