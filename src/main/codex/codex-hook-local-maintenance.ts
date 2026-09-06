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
import {
  removeRuntimeManagedHookTrustEntries,
  removeStaleRuntimeHookTrustEntries
} from './codex-hook-trust-cleanup'
import {
  applyMirroredRuntimeUserHookTrustStates,
  getRuntimeHooksWithSystemUserHooks
} from './codex-hook-user-mirroring'
import { getSystemCodexHomePath } from './codex-home-paths'
import {
  promoteCodexRuntimeHookApprovalsToSystem,
  snapshotCodexRuntimeHookTrustProvenance
} from './hook-trust-promotion'

export async function refreshCodexRuntimeUserHooksExclusively(
  runtimeHomePath: string,
  getStatus: (runtimeHomePath: string) => AgentHookInstallStatus
): Promise<AgentHookInstallStatus> {
  const configPath = getConfigPath(runtimeHomePath)
  // Why: same as install() — capture in-Orca approvals before this refresh
  // rewrites the runtime files they are keyed against.
  promoteCodexRuntimeHookApprovalsToSystem(runtimeHomePath)
  const config = readHooksJson(configPath)
  if (!config) {
    // Why: disabled launch prep once called remove(); preserve that legacy cleanup even when runtime hooks.json is malformed.
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
    // Why: this path is used when Orca status hooks are disabled. The
    // runtime CODEX_HOME should keep user hooks, but not Orca-managed trust.
    // Write current mirrored user trust first so stale cleanup compares
    // against current hashes while deleting old managed hook keys.
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
  getStatus: () => AgentHookInstallStatus
): Promise<AgentHookInstallStatus> {
  const configPath = getConfigPath()
  const configExists = existsSync(configPath)
  const config = readHooksJson(configPath)
  if (!config) {
    // Why: a malformed hooks.json shouldn't strand old hooks in ~/.codex or the legacy profile after disabling.
    await cleanupLegacyManagedHookRepresentations()
    return {
      agent: 'codex',
      state: 'error',
      configPath,
      managedHooksPresent: false,
      detail: 'Could not parse Codex hooks.json'
    }
  }

  const nextHooks = { ...config.hooks }
  // Why: same broad matcher as install() so stale entries from older builds get cleaned even if scriptPath moved.
  const isManagedCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      // Why: a non-array event value would make removeManagedCommands throw; skip it.
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
    // Why: remove() may be the only repair path for a file whose top-level plugin metadata makes Codex reject hooks.json.
    writeCodexHooksJson(configPath, nextHooks)
  }

  // Why: drop trust entries so config.toml doesn't accumulate dead [hooks.state] blocks across install/remove cycles.
  removeRuntimeManagedHookTrustEntries(configPath)

  await cleanupLegacyManagedHookRepresentations()

  return getStatus()
}
