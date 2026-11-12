import { resetCloudOfflineData } from '../../hosted-sandbox/cloud-offline-reset'
import { clearCloudReadState } from '../../cloud-workspaces/cloud-read-state'

export { revokeCloudReaderKeyBestEffort } from '../../cloud-workspaces/cloud-read-state'

/**
 * Cloud setup sign-in: the authorize page shows the setup account step (A2), and once signed in
 * the same browser tab continues to whatever `afterSignIn` returns (the setup session's URL).
 */
export type OrcaCloudSetupSignIn = {
  authorizeParams: Record<string, string>
  afterSignIn: () => Promise<string | null>
}

/** Browser sign-in endings that are the person stopping, not a failure to report. */
export const ORCA_CLOUD_AUTH_STOPPED_ERRORS: ReadonlySet<string> = new Set([
  'orca_cloud_auth_timeout',
  'orca_cloud_auth_denied',
  'orca_cloud_auth_cancelled'
])

/** Drops what belonged to the signed-out account on this profile. */
export async function clearSignedOutCloudData(
  profileId: string,
  userDataPath: string
): Promise<void> {
  // Cached Orca Cloud transcripts and queued prompts belong to the signed-out account.
  resetCloudOfflineData()
  // The next account signed in on this profile gets its own reader key and pins.
  await clearCloudReadState(profileId, userDataPath)
}
