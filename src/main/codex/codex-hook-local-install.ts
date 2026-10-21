import { mkdirSync } from 'node:fs'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  createManagedCommandMatcher,
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
  buildCodexManagedHook,
  getCodexConfigTomlPath,
  getConfigPath,
  getManagedCommand,
  getManagedScriptPath,
  writeCodexHooksJson
} from './codex-hook-definition'
import { getCodexManagedScriptFileName } from './codex-hook-identity'
import { cleanupLegacyManagedHookRepresentations } from './codex-hook-legacy-cleanup'
import { getManagedScript } from './codex-hook-script'
import type { CodexHookHashes } from './codex-hook-trust-derivation'
import { writeCodexHookApprovalsBeforeEntries } from './codex-hook-approval-first-write'
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

/**
 * A managed CODEX_HOME's hooks at launch prep: the user's hooks mirrored from
 * ~/.codex, after Orca's entry in each event Codex listed, approved with
 * Codex's own hash. The approval is written before the entry and taken back
 * if the entry write fails.
 */
export async function installCodexHooksExclusively(
  runtimeHomePath: string,
  hashes: CodexHookHashes,
  getStatus: (runtimeHomePath: string) => AgentHookInstallStatus
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

  const listedLabels = new Set(
    CODEX_EVENTS.map((eventName) => CODEX_EVENT_LABEL[eventName]).filter(
      (label) => hashes[label] !== undefined
    )
  )
  const mirroredUserTrustEntries = moveMirroredRuntimeUserTrustAfterManagedStatusHook(
    hookPlan.trustEntries,
    listedLabels
  )
  const mirroredTrustEntries: CodexTrustEntry[] = mirroredUserTrustEntries.map(({ entry }) => entry)
  const managedTrustEntries: CodexTrustEntry[] = []
  const trustSourcePath = getCodexExplicitHomeHookSourcePath(configPath)
  for (const eventName of CODEX_EVENTS) {
    const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    const trustedHash = hashes[CODEX_EVENT_LABEL[eventName]]
    if (trustedHash === undefined) {
      // Why: an event Codex does not list would never run Orca's entry, or would hold it for review.
      if (cleaned.length > 0) {
        nextHooks[eventName] = cleaned
      } else {
        delete nextHooks[eventName]
      }
      continue
    }
    const hook = buildCodexManagedHook(command, eventName)
    const definition: HookDefinition = { hooks: [hook] }
    nextHooks[eventName] = [definition, ...cleaned]
    if (trustedHash === null) {
      // Why: this Codex lists the entry with no hash, so it has no approvals to write.
      continue
    }
    // Why: the status hook must run before user hooks so a slow
    // PostToolUse/Stop hook cannot leave the sidebar stuck on the previous
    // state while Codex visibly reports that hooks are still running.
    managedTrustEntries.push({
      sourcePath: trustSourcePath,
      eventLabel: CODEX_EVENT_LABEL[eventName],
      groupIndex: 0,
      handlerIndex: 0,
      command,
      timeoutSec: hook.timeout,
      trustedHash,
      // Why: Orca's setting is the only off switch for its hook (a /hooks toggle-off is overridden).
      enabled: true
    })
  }
  const trustEntries: CodexTrustEntry[] = [...mirroredTrustEntries, ...managedTrustEntries]
  const tomlPath = getCodexConfigTomlPath(runtimeHomePath)

  config.hooks = nextHooks
  writeManagedScript(scriptPath, getManagedScript())
  try {
    // Why: the config.toml mirror and approvals land before hooks.json, which used to create the home.
    mkdirSync(runtimeHomePath, { recursive: true })
    syncSystemConfigIntoManagedCodexHome({
      runtimeHomePath,
      systemHomePath: getSystemCodexHomePath()
    })
    writeCodexHookApprovalsBeforeEntries(
      tomlPath,
      managedTrustEntries,
      () => writeCodexHooksJson(configPath, nextHooks),
      configPath
    )
  } catch (error) {
    return trustWriteError(configPath, false, error)
  }
  try {
    // Why: system user hook approvals are mirrored into runtime CODEX_HOME. If
    // the user later revokes approval in ~/.codex/config.toml, preserving all
    // old runtime [hooks.state.*] blocks would keep Orca Codex trusted.
    upsertHookTrustEntries(tomlPath, mirroredTrustEntries)
    removeStaleRuntimeHookTrustEntries(tomlPath, configPath, trustEntries)
    applyMirroredRuntimeUserHookTrustStates(tomlPath, mirroredUserTrustEntries)
  } catch (error) {
    return trustWriteError(configPath, true, error)
  }
  snapshotCodexRuntimeHookTrustProvenance(runtimeHomePath)
  await cleanupLegacyManagedHookRepresentations()
  return getStatus(runtimeHomePath)
}

function trustWriteError(
  configPath: string,
  managedHooksPresent: boolean,
  error: unknown
): AgentHookInstallStatus {
  return {
    agent: 'codex',
    state: 'error',
    configPath,
    managedHooksPresent,
    detail: `Codex hooks could not be written: ${error instanceof Error ? error.message : String(error)}`
  }
}
