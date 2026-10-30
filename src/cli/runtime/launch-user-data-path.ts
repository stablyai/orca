import { dirname, join, resolve } from 'node:path'
import { SERVE_USER_DATA_PATH_ENV } from '../../shared/serve-user-data-path'
import { getPlatformUserDataPath } from './metadata'

/** Dev builds read ORCA_DEV_USER_DATA_PATH rather than --user-data-dir. */
function launchesDevApp(env: NodeJS.ProcessEnv): boolean {
  return env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT === '1'
}

/** Resolve absolutely: the launched child runs from the app root, not the caller’s cwd. */
export function resolveLaunchUserDataPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORCA_USER_DATA_PATH) {
    return resolve(env.ORCA_USER_DATA_PATH)
  }
  if (launchesDevApp(env)) {
    return resolve(
      env.ORCA_DEV_USER_DATA_PATH || join(dirname(getPlatformUserDataPath()), 'orca-dev')
    )
  }
  return getPlatformUserDataPath()
}

/** Pin the profile through both packaged and dev entry points. */
export function pinLaunchUserDataPath(
  args: string[],
  env: NodeJS.ProcessEnv,
  userDataPath: string
): { args: string[]; env: NodeJS.ProcessEnv } {
  const pinnedEnv: NodeJS.ProcessEnv = { ...env, ORCA_USER_DATA_PATH: userDataPath }
  if (launchesDevApp(env)) {
    pinnedEnv.ORCA_DEV_USER_DATA_PATH = userDataPath
  }
  return { args: [...args, `--user-data-dir=${userDataPath}`], env: pinnedEnv }
}

/** Serve checks this profile before acquiring its instance lock. */
export function pinServeUserDataPath(
  args: string[],
  env: NodeJS.ProcessEnv,
  userDataPath: string
): { args: string[]; env: NodeJS.ProcessEnv } {
  const pinned = pinLaunchUserDataPath(args, env, userDataPath)
  return { args: pinned.args, env: { ...pinned.env, [SERVE_USER_DATA_PATH_ENV]: userDataPath } }
}
