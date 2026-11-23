import { ipcMain } from 'electron'
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  HERMES_PROFILE_NAME,
  hermesProfileRoot
} from '../../../shared/agent-launch/startup/hermes-profile'
import type { HermesLaunchProfiles } from '../../../shared/hermes/hermes-launch-profiles'
import { getHermesHome, resolveHermesActiveProfileHome } from '../../hermes/hermes-default-home'

/** The named profiles a local `hermes -p <id>` launch can pick, plus the one the current
 *  environment would use: a `HERMES_HOME` inside `profiles/`, else the sticky active choice. */
export async function listHermesLaunchProfiles(): Promise<HermesLaunchProfiles> {
  const home = getHermesHome()
  const root = hermesProfileRoot(home)
  const profiles = readdirSync(join(root, 'profiles'), { withFileTypes: true })
    .filter(
      // `default` is the root home, never a folder beside the named ones.
      (entry) =>
        entry.isDirectory() && entry.name !== 'default' && HERMES_PROFILE_NAME.test(entry.name)
    )
    .map((entry) => entry.name)
    .sort()
  const activeHome = await resolveHermesActiveProfileHome(home)
  return {
    profiles,
    active: activeHome === root ? null : basename(activeHome)
  }
}

export function registerHermesLaunchProfileHandlers(): void {
  ipcMain.handle('hermes:launchProfiles', (): Promise<HermesLaunchProfiles> =>
    listHermesLaunchProfiles()
  )
}
