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

// Why (#16441): this run clears Orca's computed trust, awaits Codex's grant, and
// may write computed trust back; a concurrent pane launch must not interleave
// with that sequence. One lane per file keeps it atomic.
export function installManagedHooksIntoWslRuntime(
  plan: CodexWslRuntimeHookInstallPlan
): Promise<AgentHookInstallStatus> {
  return runExclusivelyForCodexTrustConfig(plan.tomlPath, () =>
    installManagedHooksIntoWslRuntimeExclusively(plan)
  )
}

async function installManagedHooksIntoWslRuntimeExclusively(
  plan: CodexWslRuntimeHookInstallPlan
): Promise<AgentHookInstallStatus> {
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
    // Why: same grant-then-fallback split as the host install — codex runs
    // inside the distro so the hash authority matches the codex the pane runs.
    const runtimeHomePath = pathWin32.dirname(plan.tomlPath)
    // Why: a successful re-grant replaces the ledger. Keep the previous
    // records long enough to prove ownership of stale canonical-path keys.
    const previousLedgerHome = readCodexTrustGrantLedgerHomeForReconciliation(runtimeHomePath)
    // Why: Codex's verified RPC write must be the final config mutation. A
    // host-side rewrite after verification can race or invalidate that grant.
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
      host: { kind: 'wsl', distro: plan.wslDistro, linuxRuntimeHome: plan.linuxRuntimeHome },
      telemetryLane: 'managed'
    }
    // Why: the fallback below writes this trust back if the session fails.
    const grant = await grantManagedCodexHookTrust(grantPlan, () =>
      removeSelfComputedTrustBeforeGrant(grantPlan)
    )
    if (grant.lane === 'fallback') {
      // Why: WSL runtime homes may carry user hook approvals we did not rebuild
      // here; only upsert Orca's entries instead of sweeping the whole source.
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
    // Why: the disabled path may run after the WSL mount root changed, so cleanup can't be scoped to the plan's current source path.
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

// Why: transport failures preserve last known-good identity; a successful absence probe is strong enough to revoke trust immediately.
export function getWslHookReconciliationAction(args: {
  settlement: WslCanonicalPathSettlement
  isCurrentGeneration: boolean
  installedTrustConfigPath: string | null
  resolvedTrustConfigPath: string | null
  /** Whether the synchronous install for this generation wrote trust. */
  installSucceeded: boolean
}): 'none' | 'remove' | 'reinstall' {
  if (!args.isCurrentGeneration) {
    return 'none'
  }
  if (args.settlement.status === 'missing') {
    // Why: a `missing` directory probe right after a verified install/grant is
    // a false negative — the RPC (or fallback) just wrote and read trust in
    // that home, so it exists. Revoking here would delete the fresh grant the
    // launching pane needs, resurfacing "hooks need review". A genuinely moved
    // home resolves to a different path and takes the `reinstall` branch below.
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

// Why: fold only the Windows-case-insensitive portion; a full lowercase would let case-distinct WSL homes share one reconciliation slot.
export function getWslReconciliationKey(runtimeHomePath: string): string {
  return normalizeCodexProjectPathForLookup(runtimeHomePath)
}
