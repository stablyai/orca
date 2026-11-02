import { win32 as pathWin32 } from 'node:path'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  createManagedCommandMatcher,
  readHooksJson,
  removeManagedCommands,
  writeManagedScript,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import {
  normalizeCodexProjectPathForLookup,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  buildCodexManagedHook,
  wrapReadablePosixHookCommand,
  writeCodexHooksJson
} from './codex-hook-definition'
import {
  grantManagedCodexHookTrust,
  type CodexManagedTrustGrantPlan
} from './codex-hook-trust-grant'
import { removeSelfComputedTrustBeforeGrant } from './codex-managed-trust-grant-plan'
import { getManagedScript } from './codex-hook-script'
import {
  removeStaleWslRuntimeManagedHookTrustEntries,
  removeWslRuntimeManagedHookTrustEntries
} from './codex-hook-trust-cleanup'
import { readCodexTrustGrantLedgerHomeForReconciliation } from './codex-managed-trust-reconciliation'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import type {
  CodexWslRuntimeHookInstallPlan,
  WslCanonicalPathSettlement
} from './codex-wsl-hook-install-plan'
import { blockedWslDistroForPath } from '../wsl/wsl-unc-access-gate'

/** True when touching the distro's `\\wsl.localhost` files now would start it (E9); a user act passes. */
export async function isWslHookDistroBlocked(distro: string): Promise<boolean> {
  return (await blockedWslDistroForPath('', distro)) !== null
}

/** A WSL home whose install was skipped because its distro is stopped; the relay installs later. */
export function skippedWslHookInstallStatus(runtimeHomePath: string): AgentHookInstallStatus {
  return {
    agent: 'codex',
    state: 'not_installed',
    configPath: pathWin32.join(runtimeHomePath, 'hooks.json'),
    managedHooksPresent: false,
    detail: 'The WSL distro is not running; Orca installs these hooks once it runs.'
  }
}

/**
 * Serialize clear/grant/fallback per file so concurrent pane launches cannot interleave trust writes.
 * Null: skipped, because the distro is stopped and its UNC files would start it.
 */
export function installManagedHooksIntoWslRuntime(
  plan: CodexWslRuntimeHookInstallPlan
): Promise<AgentHookInstallStatus | null> {
  return runExclusivelyForCodexTrustConfig(plan.tomlPath, () =>
    installManagedHooksIntoWslRuntimeExclusively(plan)
  )
}

async function installManagedHooksIntoWslRuntimeExclusively(
  plan: CodexWslRuntimeHookInstallPlan
): Promise<AgentHookInstallStatus | null> {
  // Checked inside the queue, right before the first UNC read: a stop while queued must skip.
  if (await isWslHookDistroBlocked(plan.wslDistro)) {
    return null
  }
  const config = readHooksJson(plan.configPath)
  if (!config) {
    return {
      agent: 'codex',
      state: 'error',
      configPath: plan.configPath,
      managedHooksPresent: false,
      detail: 'Could not parse Codex hooks.json'
    }
  }

  const isManagedCommand = createManagedCommandMatcher('codex-hook.sh')
  const command = wrapReadablePosixHookCommand(plan.commandScriptPath)
  const nextHooks = { ...config.hooks }
  const managedEvents = new Set<string>(CODEX_EVENTS)
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (managedEvents.has(eventName) || !Array.isArray(definitions)) {
      continue
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  const trustEntries: CodexTrustEntry[] = []
  for (const eventName of CODEX_EVENTS) {
    const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
    const cleaned = removeManagedCommands(current, isManagedCommand)
    const hook = buildCodexManagedHook(command, eventName)
    const definition: HookDefinition = { hooks: [hook] }
    nextHooks[eventName] = [definition, ...cleaned]
    trustEntries.push({
      sourcePath: plan.trustConfigPath,
      eventLabel: CODEX_EVENT_LABEL[eventName],
      groupIndex: 0,
      handlerIndex: 0,
      command,
      timeoutSec: hook.timeout
    })
  }

  config.hooks = nextHooks
  writeManagedScript(plan.scriptPath, getManagedScript('posix'))
  writeCodexHooksJson(plan.configPath, nextHooks)
  try {
    const runtimeHomePath = pathWin32.dirname(plan.tomlPath)
    // Save the old ledger before re-grant replaces proof of stale canonical-path key ownership.
    const previousLedgerHome = readCodexTrustGrantLedgerHomeForReconciliation(runtimeHomePath)
    // Clean before RPC: host writes after verification can invalidate Codex's grant.
    removeStaleWslRuntimeManagedHookTrustEntries(
      plan.tomlPath,
      trustEntries,
      previousLedgerHome ? [previousLedgerHome] : []
    )
    const grantPlan: CodexManagedTrustGrantPlan = {
      runtimeHomePath,
      tomlPath: plan.tomlPath,
      managedCommand: command,
      managedEntries: trustEntries,
      // Use the distro's Codex as hash authority, matching the pane's runtime.
      host: { kind: 'wsl', distro: plan.wslDistro, linuxRuntimeHome: plan.linuxRuntimeHome }
    }
    // Fallback restores computed trust if the session fails.
    const grant = await grantManagedCodexHookTrust(grantPlan, () =>
      removeSelfComputedTrustBeforeGrant(grantPlan)
    )
    // The distro may have stopped during the hash wait; the fallback write would start it again.
    // hooks.json is already written, so report the missing trust rather than a clean skip.
    if (grant.lane === 'fallback' && (await isWslHookDistroBlocked(plan.wslDistro))) {
      return {
        agent: 'codex',
        state: 'error',
        configPath: plan.configPath,
        managedHooksPresent: true,
        detail:
          'Hooks installed but trust is pending: the WSL distro stopped before Orca could write it. Orca writes it once the distro runs.'
      }
    }
    if (grant.lane === 'fallback') {
      // Upsert only Orca's entries to preserve user approvals not rebuilt here.
      upsertHookTrustEntries(plan.tomlPath, trustEntries)
    }
  } catch (error) {
    return {
      agent: 'codex',
      state: 'error',
      configPath: plan.configPath,
      managedHooksPresent: true,
      detail: `Hooks installed but trust entries could not be written: ${error instanceof Error ? error.message : String(error)}. Run /hooks in Codex to approve.`
    }
  }

  return {
    agent: 'codex',
    state: 'installed',
    configPath: plan.configPath,
    managedHooksPresent: true,
    detail: null
  }
}

export function refreshWslRuntimeUserHooks(
  plan: CodexWslRuntimeHookInstallPlan
): AgentHookInstallStatus {
  const config = readHooksJson(plan.configPath)
  if (!config) {
    return {
      agent: 'codex',
      state: 'error',
      configPath: plan.configPath,
      managedHooksPresent: false,
      detail: 'Could not parse Codex hooks.json'
    }
  }

  const isManagedCommand = createManagedCommandMatcher('codex-hook.sh')
  const nextHooks = { ...config.hooks }
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
  writeCodexHooksJson(plan.configPath, nextHooks)
  removeWslRuntimeManagedHookTrustEntries(plan)
  try {
    // Mount roots may have changed; cleanup must include earlier source paths.
    removeStaleWslRuntimeManagedHookTrustEntries(plan.tomlPath, [])
  } catch (error) {
    console.warn('[codex-hook-service] failed to clean stale WSL trust entries', error)
  }
  return {
    agent: 'codex',
    state: 'not_installed',
    configPath: plan.configPath,
    managedHooksPresent: false,
    detail: null
  }
}

// Transport failures preserve trust; confirmed absence revokes only without a successful install.
export function getWslHookReconciliationAction(args: {
  settlement: WslCanonicalPathSettlement
  isCurrentGeneration: boolean
  installedTrustConfigPath: string | null
  resolvedTrustConfigPath: string | null
  /** Whether this generation's primary install wrote trust. */
  installSucceeded: boolean
}): 'none' | 'remove' | 'reinstall' {
  if (!args.isCurrentGeneration) {
    return 'none'
  }
  if (args.settlement.status === 'missing') {
    // A successful trust write disproves a missing-home probe; preserve the launch's fresh grant.
    return args.installSucceeded ? 'none' : 'remove'
  }
  if (
    args.settlement.status !== 'resolved' ||
    !args.resolvedTrustConfigPath ||
    args.resolvedTrustConfigPath === args.installedTrustConfigPath
  ) {
    return 'none'
  }
  return 'reinstall'
}

// Fold only Windows path portions so case-distinct WSL homes keep separate reconciliation slots.
export function getWslReconciliationKey(runtimeHomePath: string): string {
  return normalizeCodexProjectPathForLookup(runtimeHomePath)
}
