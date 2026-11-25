// `orca --profile <id> <command>`.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  APP_PROFILE_PLIST_ID_KEY,
  appProfilesRoot,
  readAppProfileMarker,
  readAppProfileRegistry,
  readPlistString
} from '../../shared/app-profiles/app-profile-paths'
import { applyAppProfileHomes } from '../../shared/app-profiles/app-profile-homes'
import { RuntimeClientError } from '../runtime/connection/types'

/**
 * Removes a `--profile <id>` that comes before the command and points the CLI at that profile.
 * After the command, `--profile` keeps its browser meaning. Order: --profile, ORCA_PROFILE,
 * ORCA_USER_DATA_PATH, the default profile. Returns the rest of argv.
 */
export function selectAppProfile(argv: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  let id: string | undefined
  let rest = argv
  const inline = argv[0]?.startsWith('--profile=')
  if (argv[0] === '--profile' || inline) {
    id = inline ? argv[0].slice('--profile='.length) : argv[1]
    rest = argv.slice(inline ? 1 : 2)
    if (!id) {
      throw new RuntimeClientError('invalid_argument', '--profile needs a profile id')
    }
  }
  id ||= env.ORCA_PROFILE || undefined
  const root = appProfilesRoot(env)
  if (id === 'default') {
    delete env.ORCA_USER_DATA_PATH
  } else if (id) {
    const profiles = readAppProfileRegistry(root)?.profiles ?? []
    const entry = profiles.find((profile) => profile.id === id)
    if (!entry) {
      const ids = ['default', ...profiles.map((profile) => profile.id)].join(', ')
      throw new RuntimeClientError('invalid_argument', `No profile "${id}". Profiles: ${ids}.`)
    }
    env.ORCA_USER_DATA_PATH = entry.userDataPath
  }
  // serve and open start the executable of the target's own app: a profile's for a profile,
  // the default app's otherwise. Never another profile's bundle.
  const userDataPath = env.ORCA_USER_DATA_PATH
  const markerId = userDataPath ? readAppProfileMarker(userDataPath) : null
  // serve, orcad and the app that this CLI starts get the target profile's folders, or none.
  applyAppProfileHomes(markerId ? userDataPath! : null, env)
  const target = markerId
    ? // The userData folder is <root>/<id>, so profiles.json is next to it.
      readAppProfileRegistry(dirname(userDataPath!))?.profiles.find((p) => p.id === markerId)
        ?.appPath
    : id === 'default'
      ? readAppProfileRegistry(root)?.defaultAppPath
      : undefined
  const executable = target ? appExecutable(target) : null
  if (executable) {
    env.ORCA_APP_EXECUTABLE = executable.path
  } else if (
    env.ORCA_APP_EXECUTABLE &&
    (markerId ||
      id === 'default' ||
      appExecutable(appOfExecutable(env.ORCA_APP_EXECUTABLE))?.isProfile)
  ) {
    delete env.ORCA_APP_EXECUTABLE
  }
  return rest
}

function appOfExecutable(executable: string): string {
  return dirname(dirname(dirname(executable)))
}

function appExecutable(appPath: string): { path: string; isProfile: boolean } | null {
  try {
    const plist = readFileSync(join(appPath, 'Contents', 'Info.plist'), 'utf8')
    const name = readPlistString(plist, 'CFBundleExecutable')
    return name
      ? {
          path: join(appPath, 'Contents', 'MacOS', name),
          isProfile: readPlistString(plist, APP_PROFILE_PLIST_ID_KEY) !== null
        }
      : null
  } catch {
    return null
  }
}
