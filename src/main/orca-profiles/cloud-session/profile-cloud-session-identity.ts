import type { OrcaCloudSession } from './profile-cloud-session-store'

/** Sessions stamped with another user's identity are never used for this profile's account. */
export function sessionBelongsToProfile(
  session: Pick<OrcaCloudSession, 'identity'>,
  cloud: { userId: string } | undefined
): boolean {
  return !session.identity || !cloud || session.identity.userId === cloud.userId
}
