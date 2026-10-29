import { restoreOrStripOverlayEnv } from '../../shared/agent-overlay-env'
import { getAppEnvironment } from '../../shared/app-environment'
import { isOpenCodeLegacySharedConfigDir } from './legacy-shared-config-dir'

const ORCA_ENV_PREFIXES = ['ORCA_OPENCODE_', 'ORCA_DATA_ACCOUNT_']
const ACCOUNT_ENV_KEYS = ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'OPENCODE_DB', 'OPENCODE_AUTH_CONTENT']

/** Run after account setup: restore user config and remove terminal-hook/account inheritance.
 * Return keys the child must not inherit; structured chats report status through chat. */
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
  // Account keys left unset by the child environment must not leak from the terminal overlay.
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
