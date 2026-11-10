import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useForgetHostClient } from '../transport/connection/host-client-hooks'
import { randomBytes } from '../transport/encryption/e2ee'
import { removeHostAndCloseClient } from '../transport/hosts/host-removal-lifecycle'
import { CloudRequestError, type CloudControlPlane } from './cloud-control-plane-request'
import { clearCloudEnrollment, loadCloudDeviceIdentity } from './cloud-device-identity'
import { signCloudDeviceToken } from './cloud-device-token'
import { clearCloudWorkspaceLinks, cloudWorkspaceHostIds } from './cloud-workspace-links'

/** The control plane as this enrolled phone, or null before enrollment. */
export async function loadCloudControlPlane(): Promise<CloudControlPlane | null> {
  const identity = await loadCloudDeviceIdentity()
  const enrollment = identity.enrollment
  if (!enrollment) {
    return null
  }
  return {
    baseUrl: enrollment.controlPlaneUrl,
    token: () =>
      signCloudDeviceToken({
        deviceSessionId: enrollment.deviceSessionId,
        secretKey: identity.secretKey,
        nowMs: Date.now(),
        nonce: randomBytes(12)
      })
  }
}

/** What removing a paired host needs from the app's React context. */
export type CloudHostRemoval = {
  forgetHostClient: (hostId: string) => void
  queryClient: QueryClient
}

export function useCloudHostRemoval(): CloudHostRemoval {
  const forgetHostClient = useForgetHostClient()
  const queryClient = useQueryClient()
  return useMemo(() => ({ forgetHostClient, queryClient }), [forgetHostClient, queryClient])
}

/** Unpairs one cloud VM host and closes its connection. */
export function cloudHostRemover(removal: CloudHostRemoval): (hostId: string) => Promise<void> {
  return (hostId) => removeHostAndCloseClient(hostId, removal.forgetHostClient, removal.queryClient)
}

/** Ends everything Orca Cloud gave this phone: its VM pairings first, then the session and key. */
export async function forgetAllCloudAccess(removal: CloudHostRemoval): Promise<void> {
  for (const hostId of await cloudWorkspaceHostIds()) {
    await removeHostAndCloseClient(hostId, removal.forgetHostClient, removal.queryClient).catch(
      () => undefined
    )
  }
  await clearCloudWorkspaceLinks()
  await clearCloudEnrollment()
}

/** A 401 means this phone's session was revoked or expired: drop all cloud access so nothing outlives it. */
export async function forgetRevokedCloudSession(
  error: unknown,
  removal: CloudHostRemoval
): Promise<boolean> {
  if (error instanceof CloudRequestError && error.status === 401) {
    await forgetAllCloudAccess(removal)
    return true
  }
  return false
}
