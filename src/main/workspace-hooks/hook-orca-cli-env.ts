import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { toLinuxPath } from '../../shared/wsl-paths'
import { prependOrcaCliDirToChildPath } from '../cli/launchers/orca-cli-child-path'
import { getManagedWslCliDir, getWslCliCommandName } from '../cli/wsl/wsl-managed-cli'
import { WSL_MANAGED_CLI_PATH_RESTORE } from '../wsl/execution/wsl-managed-cli-path-restore'

// A hook isn't a pane: an Orca started from an Orca terminal must not lend that pane's identity.
const INHERITED_PANE_IDENTITY_KEYS = [
  'ORCA_TERMINAL_HANDLE',
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_WORKSPACE_ID',
  'ORCA_WORKTREE_ID'
] as const

/** Give an in-process hook this app's `orca` CLI, as terminals get it. */
export function applyHostHookOrcaCliEnv(env: Record<string, string | undefined>): void {
  for (const key of INHERITED_PANE_IDENTITY_KEYS) {
    delete env[key]
  }
  if (!hasAppEnvironment()) {
    return
  }
  const app = getAppEnvironment()
  const userDataPath = app.getPath('userData')
  const childEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  childEnv.ORCA_USER_DATA_PATH = userDataPath
  prependOrcaCliDirToChildPath(childEnv, {
    isPackaged: app.isPackaged(),
    userDataPath,
    resourcesPath: process.resourcesPath ?? null
  })
  for (const key of Object.keys(env)) {
    if (!(key in childEnv)) {
      delete env[key]
    }
  }
  Object.assign(env, childEnv)
}

/**
 * The guest env and a script prefix that puts the managed WSL CLI first on PATH. Inherited pane
 * identity is blanked, since wsl.exe would otherwise carry the host's values in through WSLENV.
 */
export function wslHookOrcaCliEnv(): { env: Record<string, string>; scriptPrefix: string } {
  const blankedIdentity = Object.fromEntries(INHERITED_PANE_IDENTITY_KEYS.map((key) => [key, '']))
  if (!hasAppEnvironment()) {
    return { env: blankedIdentity, scriptPrefix: '' }
  }
  const app = getAppEnvironment()
  const userDataPath = app.getPath('userData')
  const managedCliDir = getManagedWslCliDir({
    isPackaged: app.isPackaged(),
    userDataPath,
    ...(process.resourcesPath ? { resourcesPath: process.resourcesPath } : {})
  })
  if (!managedCliDir) {
    return { env: blankedIdentity, scriptPrefix: '' }
  }
  return {
    env: {
      ...blankedIdentity,
      ORCA_WSL_CLI_DIR: toLinuxPath(managedCliDir),
      ORCA_CLI_COMMAND: getWslCliCommandName(app.isPackaged()),
      ORCA_USER_DATA_PATH: toLinuxPath(userDataPath)
    },
    scriptPrefix: `${WSL_MANAGED_CLI_PATH_RESTORE}\n`
  }
}
