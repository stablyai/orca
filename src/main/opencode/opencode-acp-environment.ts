import { restoreOrStripOverlayEnv } from '../../shared/agent-overlay-env'
import { getAppEnvironment } from '../../shared/app-environment'
import { isOpenCodeLegacySharedConfigDir } from './legacy-shared-config-dir'

const ORCA_ENV_PREFIXES = ['ORCA_OPENCODE_', 'ORCA_DATA_ACCOUNT_']
const ACCOUNT_ENV_KEYS = ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'OPENCODE_DB', 'OPENCODE_AUTH_CONTENT']

/**
 * A structured chat's OpenCode reports through the chat, never through Orca's terminal status
 * plugin. Restores the user's own `OPENCODE_CONFIG_DIR` over the overlay a terminal pane would have
 * (dropping it when none was recorded, or when it is the retired shared plugin directory), and drops
 * every Orca OpenCode and data-account variable. Runs after the account is applied. Returns
 * the keys the child must not inherit.
 */
export function scrubOpenCodeAcpEnvironment(
  env: Record<string, string>,
  inherited: NodeJS.ProcessEnv,
  userDataPath: string | null = orcaUserDataPath()
): string[] {
  const view: Record<string, string> = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) {
      view[key] = value
    }
  }
  Object.assign(view, env)
  restoreOrStripOverlayEnv(
    view,
    {
      primary: 'OPENCODE_CONFIG_DIR',
      overlay: 'ORCA_OPENCODE_CONFIG_DIR',
      source: 'ORCA_OPENCODE_SOURCE_CONFIG_DIR',
      preserveExplicitPrimary: true
    },
    {}
  )
  const removed: string[] = []
  if (
    view.OPENCODE_CONFIG_DIR === undefined ||
    (userDataPath !== null &&
      isOpenCodeLegacySharedConfigDir(view.OPENCODE_CONFIG_DIR, userDataPath))
  ) {
    delete env.OPENCODE_CONFIG_DIR
    removed.push('OPENCODE_CONFIG_DIR')
  } else {
    env.OPENCODE_CONFIG_DIR = view.OPENCODE_CONFIG_DIR
  }
  // The launch environment decides these; one it leaves unset must not come from Orca's overlay.
  for (const key of ACCOUNT_ENV_KEYS) {
    if (env[key] === undefined) {
      removed.push(key)
    }
  }
  for (const key of new Set([...Object.keys(env), ...Object.keys(inherited)])) {
    if (ORCA_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete env[key]
      removed.push(key)
    }
  }
  return removed
}

function orcaUserDataPath(): string | null {
  try {
    return getAppEnvironment().getPath('userData')
  } catch {
    return null
  }
}
