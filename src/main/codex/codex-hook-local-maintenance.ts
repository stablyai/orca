import { existsSync } from 'node:fs'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  createManagedCommandMatcher,
  readHooksJson,
  removeManagedCommands
} from '../agent-hooks/installer-utils'
import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'
import { upsertHookTrustEntries } from './config-toml-trust'
import { getCodexConfigTomlPath, getConfigPath, writeCodexHooksJson } from './codex-hook-definition'
import { getCodexManagedScriptFileName } from './codex-hook-identity'
import { cleanupLegacyManagedHookRepresentations } from './codex-hook-legacy-cleanup'
import { removeRealHomeCodexHookForOptOut } from './codex-real-home-hook-install'
import type { CodexHookHashes } from './codex-hook-trust-derivation'
import {
  removeRuntimeManagedHookTrustEntries,
  removeStaleRuntimeHookTrustEntries
} from './codex-hook-trust-cleanup'
import {
  applyMirroredRuntimeUserHookTrustStates,
  getRuntimeHooksWithSystemUserHooks
} from './codex-hook-user-mirroring'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import {
  promoteCodexRuntimeHookApprovalsToSystem,
  snapshotCodexRuntimeHookTrustProvenance
} from './hook-trust-promotion'

export async function refreshCodexRuntimeUserHooksExclusively(
  runtimeHomePath: string,
  getStatus: (runtimeHomePath: string) => AgentHookInstallStatus
): Promise<AgentHookInstallStatus> {
  const configPath = getConfigPath(runtimeHomePath)
  // Save in-Orca approvals before rewriting the runtime positions they are keyed against.
  promoteCodexRuntimeHookApprovalsToSystem(runtimeHomePath)
  const config = readHooksJson(configPath)
  if (!config) {
    // Malformed runtime hooks must not prevent legacy cleanup during disabled launch prep.
    await cleanupLegacyManagedHookRepresentations()
    return {
      agent: 'codex',
      state: 'error',
      configPath,
      managedHooksPresent: false,
      detail: 'Could not parse Codex hooks.json'
    }
  }

  const isManagedCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
  const hookPlan = getRuntimeHooksWithSystemUserHooks(config.hooks, isManagedCommand, configPath)
  if (!hookPlan) {
    return {
      agent: 'codex',
      state: 'error',
      configPath,
      managedHooksPresent: false,
      detail: 'Could not read system Codex hooks.json'
    }
  }
  config.hooks = hookPlan.hooks
  writeCodexHooksJson(configPath, hookPlan.hooks)

  try {
    const tomlPath = getCodexConfigTomlPath(runtimeHomePath)
    const trustEntries = hookPlan.trustEntries.map(({ entry }) => entry)
    syncSystemConfigIntoManagedCodexHome({
      runtimeHomePath,
      systemHomePath: getSystemCodexHomePath()
    })
    // Write current user hashes before stale cleanup removes managed trust with status hooks unavailable.
    upsertHookTrustEntries(tomlPath, trustEntries)
    removeStaleRuntimeHookTrustEntries(tomlPath, configPath, trustEntries)
    applyMirroredRuntimeUserHookTrustStates(tomlPath, hookPlan.trustEntries)
  } catch (error) {
    return {
      agent: 'codex',
      state: 'error',
      configPath,
      managedHooksPresent: false,
      detail: `User hooks refreshed but trust entries could not be written: ${error instanceof Error ? error.message : String(error)}. Run /hooks in Codex to approve.`
    }
  }
  snapshotCodexRuntimeHookTrustProvenance(runtimeHomePath)

  await cleanupLegacyManagedHookRepresentations()
  return getStatus(runtimeHomePath)
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
