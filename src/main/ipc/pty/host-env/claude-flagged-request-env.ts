import { claudeFlaggedRequestEnv } from '../../../../shared/agent-launch/startup/claude-flagged-request-launch'
import { overlayEnvironmentVariables } from '../../../../shared/shell/launch/environment-overlay'
import { addWslEnvKeys } from '../../../../shared/shell/wsl/wsl-env'

/** A Claude terminal this host launches gets the host's flagged-request choice, as its chats do. */
export function withClaudeFlaggedRequestTerminalEnv<Env extends Record<string, string> | undefined>(
  env: Env,
  launchesClaude: boolean,
  settings: { readonly claudeFlaggedRequestAction?: unknown } | undefined,
  platform: NodeJS.Platform = process.platform
): Env | Record<string, string> {
  const choice = launchesClaude ? claudeFlaggedRequestEnv(settings) : {}
  if (Object.keys(choice).length === 0) {
    return env
  }
  const next = overlayEnvironmentVariables(env ?? {}, choice, platform)
  if (platform === 'win32') {
    // wsl.exe imports only the variables WSLENV names.
    addWslEnvKeys(next, Object.keys(choice))
  }
  return next
}
