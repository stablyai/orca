import type { AgentHookInstallStatus } from '../../../../shared/agent-hook-listener/configuration/agent-hook-types'
import type { CodexHookHashes } from '../../trust/hooks/codex-hook-trust-derivation'
import { finishCodexHookPass, runCodexHookPassEffectsOffMain } from './codex-hook-pass-off-main'
import type { CodexLaunchConfigPreparation } from './codex-hook-launch-preparation'

export async function installCodexHooksExclusively(
  runtimeHomePath: string,
  hashes: CodexHookHashes,
  getStatus: (runtimeHomePath: string) => AgentHookInstallStatus,
  onComplete?: () => void,
  configPreparation?: CodexLaunchConfigPreparation
): Promise<AgentHookInstallStatus> {
  const effects = await runCodexHookPassEffectsOffMain(
    { mode: 'install', runtimeHomePath, hashes },
    configPreparation
  )
  return finishCodexHookPass(runtimeHomePath, effects, getStatus, onComplete)
}
