// Rolldown loads a shared chunk's modules before an entry's first import runs, so the built main
// entry applies an app profile's home folders from its banner, before any path is read.
import {
  applyAppProfileHomesCore,
  earlyAppProfileUserData
} from '../../src/shared/app-profiles/app-profile-env-core'
import { APP_PROFILE_AGENT_HOME_VARIABLES } from '../../src/shared/app-profiles/app-profile-homes'

/** The profile's ~/.orca and agent folders (or none), as code that runs before any module. */
export function createAppProfileHomesBanner(): string {
  return `/* orca: app profile homes */
;(() => {
  let userData = null
  if (process.platform === 'darwin' && process.versions.electron && !process.defaultApp) {
    const io = { readFileSync: require('node:fs').readFileSync, homedir: require('node:os').homedir }
    try {
      userData = (${earlyAppProfileUserData.toString()})(io, process.execPath, process.argv, process.env)
    } catch {}
  }
  ;(${applyAppProfileHomesCore.toString()})(process.env, userData, ${JSON.stringify(APP_PROFILE_AGENT_HOME_VARIABLES)})
})();
`
}
