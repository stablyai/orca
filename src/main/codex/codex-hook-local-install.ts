import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  readHooksJson,
  removeManagedCommands,
  writeManagedScript,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'
import {
  getCodexExplicitHomeHookSourcePath,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  getCodexConfigTomlPath,
  getConfigPath,
  getManagedCommand,
  getManagedScriptPath,
  writeCodexHooksJson
} from './codex-hook-definition'
import { getCodexManagedScriptFileName } from './codex-hook-identity'
import { cleanupLegacyManagedHookRepresentations } from './codex-hook-legacy-cleanup'
import { getManagedScript } from './codex-hook-script'
import { grantManagedCodexHookTrust } from './codex-hook-trust-grant'
import { removeStaleRuntimeHookTrustEntries } from './codex-hook-trust-cleanup'
import {
  promoteCodexRuntimeHookApprovalsToSystem,
  snapshotCodexRuntimeHookTrustProvenance
} from './hook-trust-promotion'
import {
  applyMirroredRuntimeUserHookTrustStates,
  getRuntimeHooksWithSystemUserHooks,
  moveMirroredRuntimeUserTrustAfterManagedStatusHook
} from './codex-hook-user-mirroring'
import { getSystemCodexHomePath } from './codex-home-paths'

export async function installCodexHooksExclusively(
  runtimeHomePath: string,
  getStatusAfterInstall: (
    recentGrantEntries: readonly CodexTrustEntry[],
    runtimeHomePath: string
  ) => AgentHookInstallStatus
): Promise<AgentHookInstallStatus> {
  const configPath = getConfigPath(runtimeHomePath)
  const scriptPath = getManagedScriptPath()
  // Why: must run before this install rewrites hooks.json/config.toml —
  // approvals the user made inside Orca-launched Codex are keyed to the
  // previous launch's runtime layout, and stale-trust cleanup below would
  // delete them once the system config stops backing them.
  promoteCodexRuntimeHookApprovalsToSystem(runtimeHomePath)
  const config = readHooksJson(configPath)
  if (!config) {
    return {
      agent: 'codex',
      state: 'error',
      configPath,
      managedHooksPresent: false,
      detail: 'Could not parse Codex hooks.json'
    }
  }

  // Why: match by script filename (not exact command) so a fresh install sweeps stale entries from older builds or a different userData path.
  const isManagedCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
  const command = getManagedCommand(scriptPath)
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
  const nextHooks = hookPlan.hooks
  const managedEvents = new Set<string>(CODEX_EVENTS)

  // Why: sweep managed entries from events we no longer subscribe to (e.g. a prior install's PreToolUse), else they keep firing stale hooks after upgrade.
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (managedEvents.has(eventName)) {
      continue
    }
    if (!Array.isArray(definitions)) {
      // Why: a non-array event value would make removeManagedCommands throw; skip the unparsable entry, managed events below still install.
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  // Why: Codex 0.129+ requires a per-hook config.toml trust entry or the hook needs manual /hooks-approve; precompute the hash to avoid that.
  const mirroredUserTrustEntries = moveMirroredRuntimeUserTrustAfterManagedStatusHook(
    hookPlan.trustEntries
  )
  const mirroredTrustEntries: CodexTrustEntry[] = mirroredUserTrustEntries.map(({ entry }) => entry)
  const managedTrustEntries: CodexTrustEntry[] = []
  const trustSourcePath = getCodexExplicitHomeHookSourcePath(configPath)
  for (const eventName of CODEX_EVENTS) {
    const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    const definition: HookDefinition = {
      hooks: [buildManagedCommandHook(command)]
    }
    nextHooks[eventName] = [definition, ...cleaned]
    // Why: the status hook must run before user hooks so a slow
    // PostToolUse/Stop hook cannot leave the sidebar stuck on the previous
    // state while Codex visibly reports that hooks are still running.
    // timeoutSec mirrors the hook's `timeout` so the trust hash matches the
    // entry actually written to hooks.json.
    managedTrustEntries.push({
      sourcePath: trustSourcePath,
      eventLabel: CODEX_EVENT_LABEL[eventName],
      groupIndex: 0,
      handlerIndex: 0,
      command,
      timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
    })
  }
  const trustEntries: CodexTrustEntry[] = [...mirroredTrustEntries, ...managedTrustEntries]
  let recentGrantEntries: readonly CodexTrustEntry[] = []

  config.hooks = nextHooks
  writeManagedScript(scriptPath, getManagedScript())
  writeCodexHooksJson(configPath, nextHooks)
  // Why: trust entries write last so a half-write can't leave a hash pointing at a nonexistent hook.
  // Why: surface trust-write failures — otherwise getStatus reports green for a hook Codex won't fire.
  try {
    const tomlPath = getCodexConfigTomlPath(runtimeHomePath)
    syncSystemConfigIntoManagedCodexHome({
      runtimeHomePath,
      systemHomePath: getSystemCodexHomePath()
    })
    // Why: Codex is the only authority on its trust-hash algorithm, so the
    // managed entries are granted through codex app-server RPCs (verified by
    // re-list) whenever the installed CLI supports them; the granted entries
    // then carry Codex's verbatim hashes into stale cleanup so it cannot
    // delete what Codex just wrote. Mirrored user trust keeps its existing
    // verbatim-carry lane either way.
    const grant = await grantManagedCodexHookTrust({
      runtimeHomePath,
      tomlPath,
      managedCommand: command,
      managedEntries: managedTrustEntries,
      host: { kind: 'native' },
      telemetryLane: 'managed'
    })
    if (grant.lane === 'rpc') {
      recentGrantEntries = grant.entries
      upsertHookTrustEntries(tomlPath, mirroredTrustEntries)
      removeStaleRuntimeHookTrustEntries(tomlPath, configPath, [
        ...mirroredTrustEntries,
        ...grant.entries
      ])
    } else {
      // Why: system user hook approvals are mirrored into runtime CODEX_HOME.
      // If the user later revokes approval in ~/.codex/config.toml, preserving
      // all old runtime [hooks.state.*] blocks would keep Orca Codex trusted.
      // Upsert first so duplicate repair can preserve a disabled managed copy
      // before stale cleanup removes old managed hook keys.
      upsertHookTrustEntries(tomlPath, trustEntries)
      removeStaleRuntimeHookTrustEntries(tomlPath, configPath, trustEntries)
    }
    applyMirroredRuntimeUserHookTrustStates(tomlPath, mirroredUserTrustEntries)
  } catch (error) {
    return {
      agent: 'codex',
      state: 'error',
      configPath,
      managedHooksPresent: true,
      detail: `Hooks installed but trust entries could not be written: ${error instanceof Error ? error.message : String(error)}. Run /hooks in Codex to approve.`
    }
  }
  snapshotCodexRuntimeHookTrustProvenance(runtimeHomePath)
  await cleanupLegacyManagedHookRepresentations()
  return getStatusAfterInstall(recentGrantEntries, runtimeHomePath)
}
