import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  createManagedCommandMatcher,
  readHooksJson,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import {
  codexHookSourcePathsEqual,
  getCodexExplicitHomeHookSourcePath,
  normalizeCodexHookSourcePath,
  normalizeHookTrustKeyForLookup,
  parseTrustKey,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import {
  CODEX_EVENT_NAME_BY_LABEL,
  createCodexHookTrustEntry,
  getCodexHookTrustSignature,
  getCodexManagedScriptFileName
} from './codex-hook-identity'

// Promote runtime approvals before mirroring so users do not have to approve them on every launch.

type HookTrustProvenanceEntry = {
  trustedHash?: string
  enabled?: boolean
}

type HookTrustProvenanceFile = {
  version: 1
  entries: Record<string, HookTrustProvenanceEntry>
}

function getProvenancePath(runtimeHomePath: string): string {
  return join(runtimeHomePath, '.orca-hook-trust-provenance.json')
}

/** Missing, unreadable or malformed provenance cannot establish an approval's origin. */
function readHookTrustProvenance(
  runtimeHomePath: string
): Map<string, HookTrustProvenanceEntry> | null {
  const provenancePath = getProvenancePath(runtimeHomePath)
  let rawProvenance: string
  try {
    rawProvenance = readFileSync(provenancePath, 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(rawProvenance)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const entries = (parsed as HookTrustProvenanceFile).entries
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      return null
    }
    const result = new Map<string, HookTrustProvenanceEntry>()
    for (const [key, value] of Object.entries(entries)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        result.set(key, {
          ...(typeof value.trustedHash === 'string' ? { trustedHash: value.trustedHash } : {}),
          ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {})
        })
      }
    }
    return result
  } catch {
    return null
  }
}

/** Preserve unreadable provenance so later snapshots cannot misclassify user approvals as Orca writes. */
function provenanceIsUnreadable(provenancePath: string): boolean {
  try {
    readFileSync(provenancePath, 'utf-8')
    return false
  } catch (error) {
    return !isDefinitiveAbsence(error)
  }
}

/** Snapshot after all trust writes to distinguish Orca changes from later user approvals. */
export function snapshotCodexRuntimeHookTrustProvenance(
  runtimeHomePath: string = getOrcaManagedCodexHomePath()
): void {
  if (provenanceIsUnreadable(getProvenancePath(runtimeHomePath))) {
    return
  }
  try {
    const runtimeHooksPath = join(runtimeHomePath, 'hooks.json')
    const canonicalRuntimeHooksPath = getCodexExplicitHomeHookSourcePath(runtimeHooksPath)
    const entries: Record<string, HookTrustProvenanceEntry> = {}
    for (const [key, state] of readHookTrustEntries(join(runtimeHomePath, 'config.toml'))) {
      const parsed = parseTrustKey(key)
      if (!parsed || !codexHookSourcePathsEqual(parsed.sourcePath, canonicalRuntimeHooksPath)) {
        continue
      }
      entries[normalizeHookTrustKeyForLookup(key)] = {
        ...(state.trustedHash !== undefined ? { trustedHash: state.trustedHash } : {}),
        ...(state.enabled !== undefined ? { enabled: state.enabled } : {})
      }
    }
    const file: HookTrustProvenanceFile = { version: 1, entries }
    writeFileSync(getProvenancePath(runtimeHomePath), `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600
    })
  } catch (error) {
    console.warn('[codex-hook-promotion] failed to snapshot hook trust provenance', error)
  }
}

/** Promote user approvals into canonical config before the mirror replaces runtime trust. */
export function promoteCodexRuntimeHookApprovalsToSystem(
  runtimeHomePath: string = getOrcaManagedCodexHomePath()
): void {
  try {
    promoteCodexRuntimeHookApprovalsToSystemUnsafe(runtimeHomePath)
  } catch (error) {
    // Promotion failures must not block hook installation or Codex launch.
    console.warn('[codex-hook-promotion] failed to promote runtime hook approvals', error)
  }
}

function promoteCodexRuntimeHookApprovalsToSystemUnsafe(runtimeHomePath: string): void {
  const systemHomePath = getSystemCodexHomePath()
  const runtimeHooksPath = join(runtimeHomePath, 'hooks.json')
  const systemHooksPath = join(systemHomePath, 'hooks.json')
  const canonicalRuntimeHooksPath = getCodexExplicitHomeHookSourcePath(runtimeHooksPath)
  if (canonicalRuntimeHooksPath === normalizeCodexHookSourcePath(systemHooksPath)) {
    return
  }
  const runtimeTomlPath = join(runtimeHomePath, 'config.toml')
  if (!existsSync(runtimeTomlPath)) {
    return
  }
  // Without provenance, stale mirrored trust could be mistaken for an approval and undo a revocation.
  const provenance = readHookTrustProvenance(runtimeHomePath)
  if (!provenance) {
    return
  }
  const runtimeTrust = readHookTrustEntries(runtimeTomlPath)
  if (runtimeTrust.size === 0) {
    return
  }
  // Inspect the approved layout before install rewrites runtime hooks.json.
  const runtimeConfig = readHooksJson(runtimeHooksPath)
  const systemConfig = readHooksJson(systemHooksPath)
  if (!runtimeConfig?.hooks || !systemConfig?.hooks) {
    return
  }
  const isManagedCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())

  const promotions: CodexTrustEntry[] = []
  for (const [key, state] of runtimeTrust) {
    if (!state.trustedHash) {
      continue
    }
    const parsed = parseTrustKey(key)
    if (!parsed || !codexHookSourcePathsEqual(parsed.sourcePath, canonicalRuntimeHooksPath)) {
      continue
    }
    const previous = provenance.get(normalizeHookTrustKeyForLookup(key))
    if (
      previous &&
      previous.trustedHash === state.trustedHash &&
      (previous.enabled ?? true) === (state.enabled ?? true)
    ) {
      // Unchanged Orca-written entries are not new user approvals.
      continue
    }
    const eventName = CODEX_EVENT_NAME_BY_LABEL[parsed.eventLabel]
    const runtimeDefinitions = runtimeConfig.hooks[eventName]
    const definition = Array.isArray(runtimeDefinitions)
      ? runtimeDefinitions[parsed.groupIndex]
      : undefined
    const hook = Array.isArray(definition?.hooks)
      ? definition.hooks[parsed.handlerIndex]
      : undefined
    // Keep managed-hook trust confined to the runtime home.
    if (!definition || !hook?.command || isManagedCommand(hook.command)) {
      continue
    }
    const runtimeEntry = createCodexHookTrustEntry(
      canonicalRuntimeHooksPath,
      eventName,
      parsed.groupIndex,
      parsed.handlerIndex,
      definition,
      hook
    )
    if (!runtimeEntry) {
      continue
    }
    collectSystemPromotionTargets(
      promotions,
      systemHooksPath,
      systemConfig.hooks,
      eventName,
      getCodexHookTrustSignature(runtimeEntry),
      isManagedCommand,
      state.trustedHash,
      state.enabled ?? true
    )
  }
  if (promotions.length > 0) {
    upsertHookTrustEntries(join(systemHomePath, 'config.toml'), promotions)
  }
}

// Match by content because runtime positions differ; promote to every identical system hook.
function collectSystemPromotionTargets(
  promotions: CodexTrustEntry[],
  systemHooksPath: string,
  systemHooks: Record<string, HookDefinition[]>,
  eventName: string,
  signature: string,
  isManagedCommand: (command: string | undefined) => boolean,
  trustedHash: string,
  enabled: boolean
): void {
  const systemDefinitions = systemHooks[eventName]
  if (!Array.isArray(systemDefinitions)) {
    return
  }
  systemDefinitions.forEach((systemDefinition, groupIndex) => {
    const hooks = Array.isArray(systemDefinition.hooks) ? systemDefinition.hooks : []
    hooks.forEach((systemHook, handlerIndex) => {
      if (isManagedCommand(systemHook.command)) {
        return
      }
      const systemEntry = createCodexHookTrustEntry(
        systemHooksPath,
        eventName,
        groupIndex,
        handlerIndex,
        systemDefinition,
        systemHook
      )
      if (!systemEntry || getCodexHookTrustSignature(systemEntry) !== signature) {
        return
      }
      promotions.push({ ...systemEntry, trustedHash, enabled })
    })
  })
}
