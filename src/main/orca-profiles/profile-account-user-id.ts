import { loadOrCreateProfileIndex } from './profile-index-store'

/** The account a given profile is signed in as, by id; never the active profile's. */
export function profileAccountUserId(profileId: string, userDataPath: string): string | null {
  const index = loadOrCreateProfileIndex(userDataPath)
  return index.profiles.find((profile) => profile.id === profileId)?.cloud?.userId ?? null
}
