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
    isWsl?: boolean
    launchAgent?: string
    launchCommand?: string
    explicitEnv?: Record<string, string>
  }
): Promise<void> {
  if (options.isWsl || process.platform === 'win32') {
    return
  }
  const command = resolveSetupAgentSequenceLaunchCommand(env, options.launchCommand)
  const agent = options.launchAgent ?? detectExplicitPiAgentKindFromCommand(command)
  if (agent !== 'omp' && (options.launchAgent !== undefined || command?.trim())) {
    return
  }
  const shellEnv = await resolveLoginShellEnvironment()
  for (const key of OMP_DIRECTORY_ENV_KEYS) {
    // Explicit pane values, including empty values, take precedence over the login shell.
    const value = (options.explicitEnv ?? env)[key] ?? shellEnv[key] ?? process.env[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
}
