import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { MANAGED_HOOK_TIMEOUT_SECONDS, readHooksJson } from '../agent-hooks/installer-utils'
import {
  computeTrustKey,
  computeTrustedHash,
  getCodexExplicitHomeHookSourcePath,
  normalizeHookTrustKeyForLookup,
  readHookTrustEntries,
  type CodexHookTrustState,
  type CodexTrustEntry
} from './config-toml-trust'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  getCodexConfigTomlPath,
  getConfigPath,
  getManagedCommand,
  getManagedScriptPath
} from './codex-hook-definition'
import { getCodexHookTrustSignature } from './codex-hook-identity'
import { getCodexLedgerTrustedHash } from './codex-managed-trust-reconciliation'
import { readCurrentNativeCodexTrustGrantLedgerHome } from './codex-trust-grant-host'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'

export function getCodexHookStatusAfterInstall(
  recentGrantEntries: readonly CodexTrustEntry[] | null,
  runtimeHomePath: string = getOrcaManagedCodexHomePath()
): AgentHookInstallStatus {
  const configPath = getConfigPath(runtimeHomePath)
  const scriptPath = getManagedScriptPath()
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

  // Why: Codex 0.129+ silently drops untrusted hooks, so report `partial` when managed events OR their trust entries are missing/stale.
  const command = getManagedCommand(scriptPath)
  const tomlPath = getCodexConfigTomlPath(runtimeHomePath)
  // Why: an unreadable config.toml (EACCES/EIO) is distinct from "file
  // absent" (which returns an empty Map without throwing). Hooks.json may
  // still be fine, so report partial with a specific reason rather than
  // collapsing to a generic error or masking it as universally-stale trust.
  let trustEntries: Map<string, CodexHookTrustState>
  let trustReadError: string | null = null
  try {
    trustEntries = readHookTrustEntries(tomlPath)
  } catch (error) {
    trustEntries = new Map()
    trustReadError = error instanceof Error ? error.message : String(error)
  }
  // Why: RPC-granted entries store Codex's own hash, which is authoritative
  // even when it differs from computeTrustedHash — that difference is the
  // drift bug class this lane exists to absorb, not a stale entry.
  // Why: install() already resolved the binary and either verified Codex's
  // hashes or wrote fallback hashes. Re-resolving PATH here doubles sync launch work.
  const ledgerHome =
    recentGrantEntries === null ? readCurrentNativeCodexTrustGrantLedgerHome(runtimeHomePath) : null
  const recentGrantHashes = new Map<string, { signature: string; trustedHash: string }>()
  for (const entry of recentGrantEntries ?? []) {
    if (entry.trustedHash) {
      recentGrantHashes.set(normalizeHookTrustKeyForLookup(computeTrustKey(entry)), {
        signature: getCodexHookTrustSignature(entry),
        trustedHash: entry.trustedHash
      })
    }
  }

  const missing: string[] = []
  const trustMissing: string[] = []
  const disabled: string[] = []
  const trustSourcePath = getCodexExplicitHomeHookSourcePath(configPath)
  let presentCount = 0
  for (const eventName of CODEX_EVENTS) {
    const definitions = Array.isArray(config.hooks?.[eventName]) ? config.hooks![eventName]! : []
    // Why: older installs appended, current ones prepend; last-match keeps status repair conservative when stale duplicate definitions survive.
    let foundGroupIndex = -1
    let foundHandlerIndex = -1
    definitions.forEach((definition, idx) => {
      const hooks = definition.hooks ?? []
      // Why: last-match-wins at the group level — if merged hook arrays repeat our command, the surviving runtime entry is the last one.
      const handlerIdx = hooks.findLastIndex((hook) => hook.command === command)
      if (handlerIdx !== -1) {
        foundGroupIndex = idx
        foundHandlerIndex = handlerIdx
      }
    })
    if (foundGroupIndex === -1) {
      missing.push(eventName)
      continue
    }
    presentCount += 1
    // Why: a stale hash blocks firing like a missing entry, so compare against the canonical hash we would write.
    // Why: Codex's hook_key is positional, so hardcoding handlerIndex 0 misreports trust for user-merged hook arrays.
    // Why: hash the same `timeout` install() writes, since Codex folds it into the trust hash or every managed hook reports stale-trust.
    const trustInput: CodexTrustEntry = {
      sourcePath: trustSourcePath,
      eventLabel: CODEX_EVENT_LABEL[eventName],
      groupIndex: foundGroupIndex,
      handlerIndex: foundHandlerIndex,
      command,
      timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
    }
    const trustKey = computeTrustKey(trustInput)
    const validHashes = new Set([computeTrustedHash(trustInput)])
    const grantedHash = getCodexLedgerTrustedHash(ledgerHome, trustKey, trustInput)
    if (grantedHash) {
      validHashes.add(grantedHash)
    }
    const recentGrant = recentGrantHashes.get(normalizeHookTrustKeyForLookup(trustKey))
    if (
      recentGrant?.signature === getCodexHookTrustSignature(trustInput) &&
      recentGrant.trustedHash
    ) {
      validHashes.add(recentGrant.trustedHash)
    }
    const actualState = trustEntries.get(trustKey)
    if (!actualState?.trustedHash || !validHashes.has(actualState.trustedHash)) {
      trustMissing.push(eventName)
    } else if (actualState?.enabled === false) {
      disabled.push(eventName)
    }
  }
  const managedHooksPresent = presentCount > 0
  let state: AgentHookInstallState
  let detail: string | null
  if (presentCount === 0) {
    state = 'not_installed'
    // Why: surface the trust read error even when not_installed, so a broken config.toml gives actionable info.
    detail = trustReadError !== null ? `Trust entries unverifiable: ${trustReadError}` : null
  } else if (
    missing.length === 0 &&
    trustMissing.length === 0 &&
    disabled.length === 0 &&
    trustReadError === null
  ) {
    state = 'installed'
    detail = null
  } else {
    state = 'partial'
    const parts: string[] = []
    if (missing.length > 0) {
      parts.push(`Managed hook missing for events: ${missing.join(', ')}`)
    }
    if (trustReadError !== null) {
      parts.push(`Trust entries unverifiable: ${trustReadError}`)
    } else if (trustMissing.length > 0) {
      parts.push(`Trust entry missing or stale for events: ${trustMissing.join(', ')}`)
    }
    if (disabled.length > 0) {
      parts.push(`Managed hook disabled for events: ${disabled.join(', ')}`)
    }
    detail = parts.join('; ')
  }
  return { agent: 'codex', state, configPath, managedHooksPresent, detail }
}
