import {
  CODEX_MINIMUM_SUPPORTED_VERSION,
  parseCodexCliVersion
} from '../../shared/codex-cli-installation'
import {
  checkAgentCliVersion,
  readAgentCliVersion,
  type AgentCliVersionReader
} from '../agent-cli-version-probe'
import { AgentCliInstallationError } from '../native-chat/agent-cli-installation-error'
import type { StructuredAgentLaunchResolver } from '../runtime/structured-agent-launch-composition'
import {
  resolveProviderChildEnv,
  type ProviderProcessLaunch
} from '../provider-process/provider-process-launch'

export const readCodexCliVersion: AgentCliVersionReader = (input) =>
  readAgentCliVersion(input, parseCodexCliVersion)

export async function requireSupportedCodexCli(
  input: Parameters<AgentCliVersionReader>[0],
  readVersion: AgentCliVersionReader = readCodexCliVersion
): Promise<void> {
  const check = await checkAgentCliVersion(input, [CODEX_MINIMUM_SUPPORTED_VERSION], readVersion)
  if (check.status === 'tooOld') {
    throw AgentCliInstallationError.tooOld('codex', check)
  }
  if (check.status !== 'ready') {
    console.warn(`[codex-cli-version] Could not verify ${input.program}; allowing structured chat`)
  }
}

/** Check every acquired child against the same sealed launch the app-server will use. */
export function withSupportedCodexCli<
  L extends ProviderProcessLaunch & { prefixArgs?: readonly string[] }
>(
  resolveLaunch: StructuredAgentLaunchResolver<L>,
  readVersion: AgentCliVersionReader = readCodexCliVersion
): StructuredAgentLaunchResolver<L> {
  return async (request) => {
    const launch = await resolveLaunch(request)
    await requireSupportedCodexCli(
      {
        program: launch.command,
        prefixArgs: launch.prefixArgs,
        cwd: launch.cwd,
        env: resolveProviderChildEnv(launch, process.env)
      },
      readVersion
    )
    return launch
  }
}
