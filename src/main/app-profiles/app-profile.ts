// Which app profile this process runs.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  APP_PROFILE_PLIST_ID_KEY,
  APP_PROFILE_PLIST_ROOT_KEY,
  appProfilesRoot,
  readAppProfileMarker,
  readPlistString
} from '../../shared/app-profiles/app-profile-paths'
import { ORCA_HOME_DIR_ENV } from '../../shared/app-profiles/app-profile-homes'

const DEFAULT_APP = { productName: 'Orca', appId: 'com.stablyai.orca' }

export type AppProfile = {
  id: string
  /** The name that the Dock and the window title show. */
  name: string
  /** The bundle id that macOS uses for this process. */
  bundleId: string
  userDataPath: string
}

export type AppProfileInput = {
  /** The XML Info.plist of the running bundle, or null. */
  plist: string | null
  userDataDirArg: string | null
  defaultRoot: string
  readMarker: (userDataPath: string) => string | null
}

/** Order: the bundle's own profile id, then the marker in --user-data-dir. */
export function resolveAppProfile(input: AppProfileInput): AppProfile | null {
  const plistId = input.plist ? readPlistString(input.plist, APP_PROFILE_PLIST_ID_KEY) : null
  if (input.plist && plistId) {
    const root = readPlistString(input.plist, APP_PROFILE_PLIST_ROOT_KEY) ?? input.defaultRoot
    const userDataPath = input.userDataDirArg ?? join(root, plistId)
    const markerId = input.readMarker(userDataPath)
    // A given folder must carry this profile's marker: a profile app must never take, and mark,
    // the default folder or another profile's folder.
    if (markerId ? markerId !== plistId : input.userDataDirArg !== null) {
      throw new Error(
        `This app is the profile "${plistId}", but ${userDataPath} is ${markerId ? `the profile "${markerId}"` : 'not this profile'}.`
      )
    }
    return {
      id: plistId,
      name: readPlistString(input.plist, 'CFBundleDisplayName') ?? plistId,
      bundleId: readPlistString(input.plist, 'CFBundleIdentifier') ?? DEFAULT_APP.appId,
      userDataPath
    }
  }
  const markerId = input.userDataDirArg ? input.readMarker(input.userDataDirArg) : null
  if (input.userDataDirArg && markerId) {
    // The default app's executable serves a profile: the process keeps the default identity.
    return {
      id: markerId,
      name: DEFAULT_APP.productName,
      bundleId: DEFAULT_APP.appId,
      userDataPath: input.userDataDirArg
    }
  }
  return null
}

function readOwnInfoPlist(): string | null {
  try {
    return readFileSync(join(dirname(process.execPath), '..', 'Info.plist'), 'utf8')
  } catch {
    return null
  }
}

let resolved: AppProfile | null = null

// No electron import: orcad bundles this module too. Electron takes switches only as --name=value.
function userDataDirArg(): string | null {
  const arg = process.argv.find((value) => value.startsWith('--user-data-dir='))
  return arg ? arg.slice('--user-data-dir='.length) || null : null
}

/**
 * Finds the profile of this process once, at the start of main, before userData is set. Only
 * packaged macOS Electron has profiles. One Info.plist read and one marker read.
 */
export function resolveRunningAppProfile(): AppProfile | null {
  const packagedElectron = Boolean(process.versions.electron) && !process.defaultApp
  resolved =
    process.platform === 'darwin' && packagedElectron
      ? resolveAppProfile({
          plist: readOwnInfoPlist(),
          userDataDirArg: userDataDirArg(),
          defaultRoot: appProfilesRoot(),
          readMarker: readAppProfileMarker
        })
      : null
  return resolved
}

/** The profile of this app, or null for the default app and for processes other than main. */
export function getAppProfile(): AppProfile | null {
  return resolved
}

/** The name and bundle id of the running app. */
export function runtimeAppIdentity(): { productName: string; appId: string } {
  const profile = getAppProfile()
  return profile ? { productName: profile.name, appId: profile.bundleId } : DEFAULT_APP
}

/**
 * True in a profile app, and in any process (orcad too) that serves a profile's userData: each
 * Orca entry point (the main banner, orcad, the CLI) sets ORCA_HOME_DIR only then. Such a process installs no managed hooks (the
 * hook commands use the `.orca` folder in HOME) and changes no config of the agents that stay on
 * the real home.
 */
export function isAppProfileRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[ORCA_HOME_DIR_ENV]?.trim())
}
