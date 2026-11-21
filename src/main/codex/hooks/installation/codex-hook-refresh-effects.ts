import type { CodexHookPassEffects } from './codex-hook-install-effects'
import { createManagedCommandMatcher } from '../../../agent-hooks/installation/commands/managed-hook-command-matching'
import { readHooksJson } from '../../../agent-hooks/installation/configuration/hooks-json-read'
import { syncSystemConfigIntoManagedCodexHome } from '../../configuration/settings/codex-config-mirror'
import { upsertHookTrustEntries } from '../../trust/toml/config-toml-trust'
import {
  getCodexConfigTomlPath,
  getConfigPath,
  writeCodexHooksJson
} from '../definitions/codex-hook-definition'
import { getCodexManagedScriptFileName } from '../definitions/codex-hook-identity'
import { removeStaleRuntimeHookTrustEntries } from '../../trust/hooks/codex-hook-trust-cleanup'
import { getRuntimeHooksWithSystemUserHooks } from '../../trust/hooks/codex-hook-user-mirroring'
import { getSystemCodexHomePath } from '../../configuration/homes/codex-home-paths'
import {
  promoteCodexRuntimeHookApprovalsToSystem,
  snapshotCodexRuntimeHookTrustProvenance
} from '../../trust/hooks/hook-trust-promotion'

/** A user-hook refresh pass's file effects, up to legacy cleanup; runs on the Codex trust worker. */
export function writeCodexRuntimeUserHookRefreshEffects(
  runtimeHomePath: string
): CodexHookPassEffects {
  const configPath = getConfigPath(runtimeHomePath)
  // Save in-Orca approvals before rewriting the runtime positions they are keyed against.
  let complete = promoteCodexRuntimeHookApprovalsToSystem(runtimeHomePath)
  const config = readHooksJson(configPath)
  if (!config) {
    // Malformed runtime hooks must not prevent legacy cleanup during disabled launch prep.
    return {
      kind: 'status',
      cleanupFirst: true,
      status: {
        agent: 'codex',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Codex hooks.json'
      }
    }
  }

  const isManagedCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
  const hookPlan = getRuntimeHooksWithSystemUserHooks(config.hooks, isManagedCommand, configPath)
  if (!hookPlan) {
    return {
      kind: 'status',
      status: {
        agent: 'codex',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read system Codex hooks.json'
      }
    }
  }
  config.hooks = hookPlan.hooks
  writeCodexHooksJson(configPath, hookPlan.hooks)

  try {
    const tomlPath = getCodexConfigTomlPath(runtimeHomePath)
    // The enabled state goes in the first write so an interrupted pass never leaves a disable enabled.
    const trustEntries = hookPlan.trustEntries.map(({ entry, enabled }) => ({ ...entry, enabled }))
    const mirrored = syncSystemConfigIntoManagedCodexHome({
      runtimeHomePath,
      systemHomePath: getSystemCodexHomePath()
    })
    complete = mirrored && complete
    // Write current user hashes before stale cleanup removes managed trust with status hooks unavailable.
    upsertHookTrustEntries(tomlPath, trustEntries)
    removeStaleRuntimeHookTrustEntries(tomlPath, configPath, trustEntries)
  } catch (error) {
    return {
      kind: 'status',
      status: {
        agent: 'codex',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: `User hooks refreshed but trust entries could not be written: ${error instanceof Error ? error.message : String(error)}. Run /hooks in Codex to approve.`
      }
    }
  }
  const snapshotted = snapshotCodexRuntimeHookTrustProvenance(runtimeHomePath)
  return { kind: 'written', complete: complete && snapshotted }
}
