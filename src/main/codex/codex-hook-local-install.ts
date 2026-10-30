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

export async function installCodexHooksExclusively(
  runtimeHomePath: string,
  hashes: CodexHookHashes,
  getStatus: (runtimeHomePath: string) => AgentHookInstallStatus
): Promise<AgentHookInstallStatus> {
  const configPath = getConfigPath(runtimeHomePath)
  const scriptPath = getManagedScriptPath()
  // Save in-Orca approvals before rewriting their runtime positions or cleaning stale trust.
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

  // Match by filename to catch older builds' commands and relocated userData paths.
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

  // Remove subscriptions to retired events so stale hooks stop firing after upgrades.
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (managedEvents.has(eventName)) {
      continue
    }
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
      // Unlisted events cannot run Orca's hook without review, if at all.
      if (cleaned.length > 0) {
        nextHooks[eventName] = cleaned
      } else {
        delete nextHooks[eventName]
      }
      continue
    }
    const hook = buildCodexManagedHook(command, eventName)
    const definition: HookDefinition = { hooks: [hook] }
    // Report status before slow user hooks can leave the sidebar displaying the previous state.
    nextHooks[eventName] = [definition, ...cleaned]
    if (trustedHash === null) {
      // Listed entries without hashes need no approval.
      continue
    }
    managedTrustEntries.push({
      sourcePath: trustSourcePath,
      eventLabel: CODEX_EVENT_LABEL[eventName],
      groupIndex: 0,
      handlerIndex: 0,
      command,
      timeoutSec: hook.timeout,
      trustedHash,
      // Orca's setting overrides Codex's /hooks off switch for this hook.
      enabled: true
    })
  }
  const trustEntries: CodexTrustEntry[] = [...mirroredTrustEntries, ...managedTrustEntries]
  const tomlPath = getCodexConfigTomlPath(runtimeHomePath)

  config.hooks = nextHooks
  writeManagedScript(scriptPath, getManagedScript())
  try {
    // Config mirroring and approvals need the home before hooks.json creates it.
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
    // Reconcile revoked system approvals too; retaining old runtime trust would leave hooks approved.
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
