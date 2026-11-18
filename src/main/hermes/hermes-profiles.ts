import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { isHermesProfileName, type HermesProfilesSnapshot } from '../../shared/hermes-profiles'
import { getHermesHome } from './hermes-default-home'

async function readActiveProfile(home: string): Promise<string> {
  try {
    const value = (await readFile(join(home, 'active_profile'), 'utf-8')).trim()
    return isHermesProfileName(value) ? value : 'default'
  } catch {
    return 'default'
  }
}

/** Named profiles Hermes would accept for `hermes --profile <name>`. */
export async function listHermesProfiles(home = getHermesHome()): Promise<HermesProfilesSnapshot> {
  const profilesDir = join(home, 'profiles')
  const [activeProfile, entries] = await Promise.all([
    readActiveProfile(home),
    readdir(profilesDir, { withFileTypes: true }).catch(() => [])
  ])
  const candidates = entries.filter((entry) => isHermesProfileName(entry.name))
  const directories = await Promise.all(
    candidates.map(async (entry) => {
      try {
        return (await stat(join(profilesDir, entry.name))).isDirectory() ? entry.name : null
      } catch {
        return null
      }
    })
  )
  return {
    profiles: directories.filter((name): name is string => name !== null).sort(),
    activeProfile
  }
}
