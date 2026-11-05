import { addWslEnvKeys } from '../../../../shared/wsl-env'
import { detectExplicitPiAgentKindFromCommand } from '../../../../shared/pi-agent-kind'
import { resolveSetupAgentSequenceLaunchCommand } from '../../../../shared/setup-agent-sequencing'
import { resolveLoginShellEnvironment } from '../../../startup/login-shell-environment'

const OMP_DIRECTORY_ENV_KEYS = [
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'PI_CONFIG_DIR'
] as const

export async function inheritOmpLaunchEnvironment(
  env: Record<string, string>,
  options: {
    shellPath?: string
    isWsl?: boolean
    launchAgent?: string
    launchCommand?: string
    explicitEnv?: Record<string, string>
  }
): Promise<void> {
  if (options.isWsl) {
    const explicitEnv = options.explicitEnv ?? env
    const keys = OMP_DIRECTORY_ENV_KEYS.filter((key) => explicitEnv[key] !== undefined)
    if (keys.length > 0) {
      // WSL drops pane-provided config roots unless their names cross in WSLENV.
      for (const key of keys) {
        env[key] = key === 'PI_CONFIG_DIR' && explicitEnv[key] === '' ? '.omp' : explicitEnv[key]
      }
      addWslEnvKeys(env, keys)
    }
    return
  }
  if (process.platform === 'win32') {
    return
  }
  const command = resolveSetupAgentSequenceLaunchCommand(env, options.launchCommand)
  const agent = options.launchAgent ?? detectExplicitPiAgentKindFromCommand(command)
  if (agent !== 'omp' && (options.launchAgent !== undefined || command?.trim())) {
    return
  }
  const shellPath =
    options.shellPath || (options.explicitEnv ?? env).SHELL || process.env.SHELL || '/bin/zsh'
  const shellEnv = await resolveLoginShellEnvironment({ shellOverride: shellPath })
  for (const key of OMP_DIRECTORY_ENV_KEYS) {
    // Explicit pane values take precedence over the login shell.
    const value = (options.explicitEnv ?? env)[key] ?? shellEnv[key] ?? process.env[key]
    if (value !== undefined) {
      // OMP maps an empty config name to .omp; spell it out before profile defaults run.
      env[key] = key === 'PI_CONFIG_DIR' && value === '' ? '.omp' : value
    }
  }
}
