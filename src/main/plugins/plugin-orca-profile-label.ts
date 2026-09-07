import { getOrcaProfileIndexPath, readProfileIndex } from '../orca-profiles/profile-index-store'

/** Active Orca profile display name. Never email or cloud user id. */
export function readActiveOrcaProfileLabel(userDataPath: string): string | null {
  const index = readProfileIndex(getOrcaProfileIndexPath(userDataPath))
  const name = index?.profiles.find((profile) => profile.id === index.activeProfileId)?.name.trim()
  return name || null
}
