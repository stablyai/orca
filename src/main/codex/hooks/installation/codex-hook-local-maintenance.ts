import { existsSync } from 'node:fs'
import type { AgentHookInstallStatus } from '../../../../shared/agent-hook-listener/configuration/agent-hook-types'
import { getConfigPath } from '../definitions/codex-hook-definition'
import { stripCodexManagedHooksFromHome } from './codex-hook-managed-strip'
import { cleanupLegacyManagedHookRepresentations } from '../reconciliation/codex-hook-legacy-cleanup'
import { finishCodexHookPass, runCodexHookPassEffectsOffMain } from './codex-hook-pass-off-main'
import type { CodexLaunchConfigPreparation } from './codex-hook-launch-preparation'
import { removeRealHomeCodexHookForOptOut } from '../reconciliation/codex-real-home-hook-install'
import type { CodexHookHashes } from '../../trust/hooks/codex-hook-trust-derivation'
import { getOrcaManagedCodexHomePath } from '../../configuration/homes/codex-home-paths'

export async function refreshCodexRuntimeUserHooksExclusively(
  runtimeHomePath: string,
  getStatus: (runtimeHomePath: string) => AgentHookInstallStatus,
  onComplete?: () => void,
  configPreparation?: CodexLaunchConfigPreparation
): Promise<AgentHookInstallStatus> {
  const effects = await runCodexHookPassEffectsOffMain(
    { mode: 'refresh', runtimeHomePath },
    configPreparation
  )
  return finishCodexHookPass(runtimeHomePath, effects, getStatus, onComplete)
}

export async function removeCodexHooksExclusively(
  codexHashes: readonly CodexHookHashes[],
  getStatus: () => AgentHookInstallStatus
): Promise<AgentHookInstallStatus> {
  const configPath = getConfigPath()
  if (existsSync(configPath)) {
    // Rebuild first to move user approvals back from slots shifted by Orca's group.
    await refreshCodexRuntimeUserHooksExclusively(getOrcaManagedCodexHomePath(), getStatus)
  }
  // Rebuild leaves runtime hooks untouched when system hooks are unreadable, so strip them here too.
  if (!stripCodexManagedHooksFromHome(getOrcaManagedCodexHomePath(), codexHashes)) {
    // A malformed runtime file must not strand real-home or legacy hooks after disabling.
    await removeRealHomeCodexHookForOptOut(codexHashes)
    await cleanupLegacyManagedHookRepresentations()
    return {
      agent: 'codex',
      state: 'error',
      configPath,
      managedHooksPresent: false,
      detail: 'Could not parse Codex hooks.json'
    }
  }

  // Shared real-home hooks may be removed only on explicit opt-out.
  await removeRealHomeCodexHookForOptOut(codexHashes)
  await cleanupLegacyManagedHookRepresentations()

  return getStatus()
}
