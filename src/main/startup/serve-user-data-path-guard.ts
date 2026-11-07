import { SERVE_USER_DATA_PATH_ENV, isSameUserDataPath } from '../../shared/serve-user-data-path'

/** Reject mismatched serve profiles before locking: a lock loss on the wrong profile can activate the user's desktop. */
export function checkServeUserDataPath(options: {
  isServeMode: boolean
  userDataPath: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): string | null {
  const env = options.env ?? process.env
  const expected = env[SERVE_USER_DATA_PATH_ENV]
  // Consume the expectation so hosted terminals cannot inherit stale profile fences.
  delete env[SERVE_USER_DATA_PATH_ENV]
  if (!options.isServeMode || !expected) {
    return null
  }
  if (isSameUserDataPath(expected, options.userDataPath, options.platform)) {
    return null
  }
  return `[serve] orca serve chose the profile at ${expected}, but this launch resolved ${options.userDataPath}; refusing to start so it cannot touch another profile's running Orca.`
}
