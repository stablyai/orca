import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { AcpAccountBinding } from '../acp/acp-account-binding'
import {
  definedEnvironment,
  MANAGED_DATA_ACCOUNT_MARKER_ENV_KEYS,
  restoredManagedDataAccountEnvironment
} from '../managed-data-accounts/managed-data-account-restored-environment'
import {
  getManagedDataAccountService,
  type ManagedDataAccountService
} from '../managed-data-accounts/service'
import { resolveStructuredEnvAccountHomePath } from '../runtime/structured-agent-account-home'

type DevinManagedAccounts = Pick<
  ManagedDataAccountService,
  'launchEnvironment' | 'transcriptEnvironments' | 'restoreOriginalEnvironment' | 'root'
>

type DevinAccountDeps = {
  managedAccounts?: () => DevinManagedAccounts
  platform?: NodeJS.Platform
  homePath?: string
  processEnv?: NodeJS.ProcessEnv
}

const DEVIN_API_KEY_ENV = 'WINDSURF_API_KEY'
const OVERLAY_DATA_ENV_KEYS = ['XDG_DATA_HOME', 'XDG_STATE_HOME'] as const

// Devin ignores DEVIN_HOME: its sign-in and sessions.db follow the data folder.
function dataHomeVariable(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'APPDATA' : 'XDG_DATA_HOME'
}

function defaultDataHome(platform: NodeJS.Platform, homePath: string): string {
  return platform === 'win32'
    ? join(homePath, 'AppData', 'Roaming')
    : join(homePath, '.local', 'share')
}

/** Pins Devin's data folder so a resume cannot change account. */
export function devinAcpAccountBinding(deps: DevinAccountDeps = {}): AcpAccountBinding {
  const platform = deps.platform ?? process.platform
  const variable = dataHomeVariable(platform)
  const managedAccounts = deps.managedAccounts ?? getManagedDataAccountService
  const homeOf = (env: NodeJS.ProcessEnv) =>
    deps.homePath ?? env.HOME ?? env.USERPROFILE ?? homedir()
  return {
    pin: { accountHomeVariable: variable },
    resolve: async ({ launchEnv }) => {
      const accounts = managedAccounts()
      const managed =
        platform === 'win32' ? undefined : accounts.launchEnvironment('devin').XDG_DATA_HOME
      // An Orca started from a managed terminal inherits that account's overlay.
      const launch = restoredManagedDataAccountEnvironment(launchEnv, accounts)
      return {
        variable,
        path:
          managed ??
          resolveStructuredEnvAccountHomePath({
            launchEnv: launch,
            variable,
            processEnv: restoredManagedDataAccountEnvironment(
              deps.processEnv ?? process.env,
              accounts
            ),
            defaultPath: () => defaultDataHome(platform, homeOf(launch))
          })
      }
    },
    environment: (home, env) => {
      if (!isLegacyAgentSessionAccountHome(home) || home.variable !== variable) {
        throw new Error(`Devin chats pin ${variable}`)
      }
      const accounts = managedAccounts()
      const restored = definedEnvironment(restoredManagedDataAccountEnvironment(env, accounts))
      if (resolve(home.path).startsWith(join(accounts.root, 'devin') + sep)) {
        // Spawning would recreate a removed account's folder, signed out.
        if (!accounts.transcriptEnvironments('devin').some((e) => e.XDG_DATA_HOME === home.path)) {
          throw new Error('The managed Devin account this chat used was removed.')
        }
        // Another account's key would win over this account's sign-in.
        delete restored[DEVIN_API_KEY_ENV]
      }
      // Exporting the default moves other tools' data on macOS, e.g. fnm's.
      if (
        restored[variable] === undefined &&
        home.path === defaultDataHome(platform, homeOf(env))
      ) {
        return restored
      }
      return { ...restored, [variable]: home.path }
    }
  }
}

/** Account keys the resolved environment left unset must not return through inheritance. */
export function scrubDevinAcpEnvironment(env: Record<string, string>): string[] {
  return [
    ...MANAGED_DATA_ACCOUNT_MARKER_ENV_KEYS,
    ...OVERLAY_DATA_ENV_KEYS,
    DEVIN_API_KEY_ENV
  ].filter((key) => env[key] === undefined)
}
