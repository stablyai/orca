import { existsSync } from 'node:fs'
import type { AgentHookInstallStatus } from '../../../../shared/agent-hook-listener/configuration/agent-hook-types'
import {
  createManagedCommandMatcher,
  removeManagedCommands
} from '../../../agent-hooks/installation/commands/managed-hook-command-matching'
import { readHooksJson } from '../../../agent-hooks/installation/configuration/hooks-json-read'
import { getConfigPath, writeCodexHooksJson } from '../definitions/codex-hook-definition'
import { getCodexManagedScriptFileName } from '../definitions/codex-hook-identity'
import { cleanupLegacyManagedHookRepresentations } from '../reconciliation/codex-hook-legacy-cleanup'
import { finishCodexHookPass, runCodexHookPassEffectsOffMain } from './codex-hook-pass-off-main'
import type { CodexLaunchConfigPreparation } from './codex-hook-launch-preparation'
import { removeRealHomeCodexHookForOptOut } from '../reconciliation/codex-real-home-hook-install'
import type { CodexHookHashes } from '../../trust/hooks/codex-hook-trust-derivation'
import { removeRuntimeManagedHookTrustEntries } from '../../trust/hooks/codex-hook-trust-cleanup'
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
  const configExists = existsSync(configPath)
  const config = readHooksJson(configPath)
  if (!config) {
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

  // Rebuild leaves runtime hooks untouched when system hooks are unreadable, so strip them here too.
  const nextHooks = { ...config.hooks }
  // Match by filename to remove older builds' hooks even after script relocation.
  const isManagedCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }
  if (configExists) {
    // Strip top-level plugin metadata that makes Codex reject hooks.json.
    writeCodexHooksJson(configPath, nextHooks)
  }

  removeRuntimeManagedHookTrustEntries(configPath, codexHashes)

  // Shared real-home hooks may be removed only on explicit opt-out.
  await removeRealHomeCodexHookForOptOut(codexHashes)
  await cleanupLegacyManagedHookRepresentations()

  return getStatus()
}
