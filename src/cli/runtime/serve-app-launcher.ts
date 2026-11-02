import { accessSync, constants } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path'
import { RuntimeClientError } from './types'
import { resolveLaunchUserDataPath } from './launch-user-data-path'

/**
 * Only a CLI run by an installed Orca app's executable can start a server. The `orca` that an
 * SSH-launched Orca server puts on a remote host runs on plain Node, belongs to that server's
 * profile, and is rewritten with each server version.
 */
export function canStartOrcaServer(env: NodeJS.ProcessEnv): boolean {
  const override = env.ORCA_APP_EXECUTABLE
  return (
    (typeof override === 'string' && override.trim().length > 0) || env.ELECTRON_RUN_AS_NODE === '1'
  )
}

/** Linux installs the app's CLI as `orca-ide`: a bare `orca` there is often the screen reader. */
export function appCliName(platform: NodeJS.Platform): string {
  return platform === 'linux' ? 'orca-ide' : 'orca'
}

const NOT_AN_APP_CLI =
  "This `orca` command isn't running from an installed Orca app. On a host Orca reaches over SSH, it belongs to that connection's server and can't start one of its own."

export function serverOnlyServeMessage(platform: NodeJS.Platform): string {
  return `${NOT_AN_APP_CLI} Install the Orca app on this machine and run \`${appCliName(platform)} serve\` from a plain login shell, or set ORCA_APP_EXECUTABLE to the Orca app executable.`
}

function serverOnlyServiceInstallMessage(platform: NodeJS.Platform): string {
  const name = appCliName(platform)
  return `Could not find the installed Orca app's \`${name}\` command on PATH. ${NOT_AN_APP_CLI} Install the Orca app on this machine, then run \`${name} serve service install\` from a plain login shell so the service uses the app's own profile, or pass --command <absolute path to the app's ${name}>.`
}

function isVersionScopedDir(dir: string, userData: string): boolean {
  const inside = relative(userData, dir)
  return (
    inside === '' ||
    (!inside.startsWith('..') && !isAbsolute(inside)) ||
    dir.includes('orcad-artifacts') ||
    dir.includes('/.mount_')
  )
}

/** The stable launcher on PATH: a version-specific executable would vanish with the next update. */
export function resolveServiceCommand(
  explicit: string | null,
  deps: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv }
): string {
  const isExecutable = (path: string): boolean => {
    try {
      accessSync(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  const userData = resolveLaunchUserDataPath(deps.env)
  if (explicit) {
    if (!isAbsolute(explicit) || !isExecutable(explicit)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--command must be an absolute path to an executable: ${explicit}`
      )
    }
    if (isVersionScopedDir(dirname(explicit), userData)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--command points at a launcher tied to one Orca version, which the next update replaces: ${explicit}. Pass the installed Orca app's \`${appCliName(deps.platform)}\` instead.`
      )
    }
    return explicit
  }
  const name = appCliName(deps.platform)
  for (const dir of (deps.env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
    // Why skip: launchers under the profile or a mounted AppImage point at one version's files.
    if (!isVersionScopedDir(dir, userData) && isExecutable(join(dir, name))) {
      return join(dir, name)
    }
  }
  throw new RuntimeClientError(
    'cli_not_found',
    canStartOrcaServer(deps.env)
      ? `Could not find the \`${name}\` command on PATH. Install it from Orca Settings, or pass --command <absolute path>.`
      : serverOnlyServiceInstallMessage(deps.platform)
  )
}
