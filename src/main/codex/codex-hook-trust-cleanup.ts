import { win32 as pathWin32 } from 'node:path'
import { MANAGED_HOOK_TIMEOUT_SECONDS, type HookDefinition } from '../agent-hooks/installer-utils'
import {
  codexHookSourcePathsEqual,
  computeTrustKey,
  computeTrustedHash,
  getCodexExplicitHomeHookSourcePath,
  normalizeHookTrustKeyForLookup,
  parseTrustKey,
  readHookTrustEntries,
  removeHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import {
  CODEX_MANAGED_EVENT_LABELS,
  getCodexConfigTomlPath,
  getManagedCommand,
  getManagedScriptPath,
  getSystemCodexConfigTomlPath,
  wrapReadablePosixHookCommand
} from './codex-hook-definition'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'
import {
  removeCodexManagedHookTrustEntries,
  removeStaleWslCodexManagedHookTrustEntries
} from './codex-managed-trust-reconciliation'
import type { CodexTrustGrantLedgerHome } from './codex-trust-grant-ledger'
import type { CodexWslRuntimeHookInstallPlan } from './codex-wsl-hook-install-plan'

export function collectManagedTrustEntries(
  sourcePath: string,
  eventName: string,
  definitions: readonly HookDefinition[],
  isManagedCommand: (command: string | undefined) => boolean
): CodexTrustEntry[] {
  const entries: CodexTrustEntry[] = []
  definitions.forEach((definition, groupIndex) => {
    const hooks = Array.isArray(definition.hooks) ? definition.hooks : []
    hooks.forEach((hook, handlerIndex) => {
      if (!isManagedCommand(hook.command)) {
        return
      }
      const entry = createCodexHookTrustEntry(
        sourcePath,
        eventName,
        groupIndex,
        handlerIndex,
        definition,
        hook
      )
      if (entry) {
        entries.push(entry)
      }
    })
  })
  return entries
}

export function removeSelfComputedMatchingTrustEntries(
  configPath: string,
  entries: readonly CodexTrustEntry[]
): void {
  if (entries.length === 0) {
    return
  }

  const existingEntries = readHookTrustEntries(configPath)
  const ownedKeys = entries
    .map((entry) => {
      const key = computeTrustKey(entry)
      return existingEntries.get(key)?.trustedHash === computeTrustedHash(entry) ? key : null
    })
    .filter((key): key is string => key !== null)
  if (ownedKeys.length > 0) {
    removeHookTrustEntries(configPath, ownedKeys)
  }
}

export function removeStaleRuntimeHookTrustEntries(
  tomlPath: string,
  runtimeHooksPath: string,
  expectedEntries: readonly CodexTrustEntry[]
): void {
  const expectedHashes = new Map(
    expectedEntries.map((entry) => [
      normalizeHookTrustKeyForLookup(computeTrustKey(entry)),
      entry.trustedHash ?? computeTrustedHash(entry)
    ])
  )
  const canonicalRuntimeHooksPath = getCodexExplicitHomeHookSourcePath(runtimeHooksPath)
  const staleKeys: string[] = []
  for (const [key, state] of readHookTrustEntries(tomlPath)) {
    const parsed = parseTrustKey(key)
    if (!parsed || !codexHookSourcePathsEqual(parsed.sourcePath, canonicalRuntimeHooksPath)) {
      continue
    }
    if (expectedHashes.get(normalizeHookTrustKeyForLookup(key)) === state.trustedHash) {
      continue
    }
    staleKeys.push(key)
  }
  if (staleKeys.length > 0) {
    removeHookTrustEntries(tomlPath, staleKeys)
  }
}

export function removeSystemManagedHookTrustEntries(
  systemHomePath: string,
  hooksJsonPath: string
): void {
  removeCodexManagedHookTrustEntries({
    tomlPath: getSystemCodexConfigTomlPath(),
    runtimeHomePath: systemHomePath,
    sourcePath: hooksJsonPath,
    command: getManagedCommand(getManagedScriptPath()),
    managedEventLabels: CODEX_MANAGED_EVENT_LABELS,
    timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
  })
}

export function removeRuntimeManagedHookTrustEntries(configPath: string): void {
  try {
    removeCodexManagedHookTrustEntries({
      tomlPath: getCodexConfigTomlPath(),
      runtimeHomePath: getOrcaManagedCodexHomePath(),
      sourcePath: configPath,
      command: getManagedCommand(getManagedScriptPath()),
      managedEventLabels: CODEX_MANAGED_EVENT_LABELS,
      timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS,
      sourceUsesExplicitCodexHome: true
    })
  } catch (error) {
    // Best effort — stale trust is harmless once hooks.json no longer references the hook; log so a programmer error isn't silent.
    console.warn('[codex-hook-service] failed to clean trust entries', error)
  }
}

export function removeWslRuntimeManagedHookTrustEntries(
  plan: CodexWslRuntimeHookInstallPlan
): void {
  try {
    removeCodexManagedHookTrustEntries({
      tomlPath: plan.tomlPath,
      runtimeHomePath: pathWin32.dirname(plan.tomlPath),
      sourcePath: plan.trustConfigPath,
      command: wrapReadablePosixHookCommand(plan.commandScriptPath),
      managedEventLabels: CODEX_MANAGED_EVENT_LABELS,
      timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
    })
  } catch (error) {
    // Why: best-effort like host cleanup; stale trust is inert once hooks.json no longer points at us.
    console.warn('[codex-hook-service] failed to clean WSL trust entries', error)
  }
}

export function removeStaleWslRuntimeManagedHookTrustEntries(
  tomlPath: string,
  desiredEntries: readonly CodexTrustEntry[],
  priorLedgerHomes: readonly CodexTrustGrantLedgerHome[] = []
): void {
  removeStaleWslCodexManagedHookTrustEntries({
    tomlPath,
    runtimeHomePath: pathWin32.dirname(tomlPath),
    desiredEntries,
    managedEventLabels: CODEX_MANAGED_EVENT_LABELS,
    timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS,
    buildManagedCommand: (linuxRuntimeHome) =>
      wrapReadablePosixHookCommand(`${linuxRuntimeHome}/.orca/agent-hooks/codex-hook.sh`),
    priorLedgerHomes
  })
}
