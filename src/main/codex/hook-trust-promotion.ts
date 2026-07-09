import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createManagedCommandMatcher,
  readHooksJson,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import {
  getCodexCanonicalTrustPath,
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

// Why: ~/.codex/config.toml is the single source of truth for user-hook
// trust, but the Codex TUI can only write approvals into the runtime
// CODEX_HOME it was launched with. Without promoting those approvals back,
// removeStaleRuntimeHookTrustEntries deletes them on the next launch and the
// user re-approves the same hooks forever.

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

function readHookTrustProvenance(
  runtimeHomePath: string
): Map<string, HookTrustProvenanceEntry> | null {
  const provenancePath = getProvenancePath(runtimeHomePath)
  if (!existsSync(provenancePath)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(provenancePath, 'utf-8'))
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

/**
 * Records the runtime config.toml trust state Orca leaves behind after an
 * install/refresh, so the next launch can tell "entry Orca wrote" apart from
 * "entry Codex wrote after a user approval". Call after all trust writes.
 */
export function snapshotCodexRuntimeHookTrustProvenance(): void {
  try {
    const runtimeHomePath = getOrcaManagedCodexHomePath()
    const runtimeHooksPath = join(runtimeHomePath, 'hooks.json')
    const canonicalRuntimeHooksPath = getCodexCanonicalTrustPath(runtimeHooksPath)
    const entries: Record<string, HookTrustProvenanceEntry> = {}
    for (const [key, state] of readHookTrustEntries(join(runtimeHomePath, 'config.toml'))) {
      const parsed = parseTrustKey(key)
      if (!parsed || getCodexCanonicalTrustPath(parsed.sourcePath) !== canonicalRuntimeHooksPath) {
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
    // Best effort — a missing snapshot only means the next launch re-promotes
    // entries that already match the system config, which upsert no-ops.
    console.warn('[codex-hook-promotion] failed to snapshot hook trust provenance', error)
  }
}

/**
 * Promotes hook approvals the user made inside Orca-launched Codex (written
 * by Codex into the runtime config.toml) into ~/.codex/config.toml, keyed to
 * the user's own hooks.json. Runs before the config mirror so the promoted
 * trust is mirrored back on the same launch.
 */
export function promoteCodexRuntimeHookApprovalsToSystem(): void {
  try {
    promoteCodexRuntimeHookApprovalsToSystemUnsafe()
  } catch (error) {
    // Why: promotion is best-effort launch prep; a malformed runtime file
    // must not block hook install or the Codex launch itself.
    console.warn('[codex-hook-promotion] failed to promote runtime hook approvals', error)
  }
}

function promoteCodexRuntimeHookApprovalsToSystemUnsafe(): void {
  const runtimeHomePath = getOrcaManagedCodexHomePath()
  const systemHomePath = getSystemCodexHomePath()
  const runtimeHooksPath = join(runtimeHomePath, 'hooks.json')
  const systemHooksPath = join(systemHomePath, 'hooks.json')
  const canonicalRuntimeHooksPath = getCodexCanonicalTrustPath(runtimeHooksPath)
  if (canonicalRuntimeHooksPath === getCodexCanonicalTrustPath(systemHooksPath)) {
    return
  }
  const runtimeTomlPath = join(runtimeHomePath, 'config.toml')
  if (!existsSync(runtimeTomlPath)) {
    return
  }
  // Why: without a snapshot of what Orca last wrote (first launch after
  // upgrading to a build with promotion, or a corrupted snapshot), a mirrored
  // copy of since-revoked system trust is indistinguishable from a genuine
  // in-Orca approval. Promoting would resurrect trust the user revoked in
  // ~/.codex, so skip this launch — install() writes the first snapshot and
  // promotion starts on the next one.
  const provenance = readHookTrustProvenance(runtimeHomePath)
  if (!provenance) {
    return
  }
  const runtimeTrust = readHookTrustEntries(runtimeTomlPath)
  if (runtimeTrust.size === 0) {
    return
  }
  // Why: promotion inspects the hooks.json layout Codex actually approved
  // against — the one still on disk from the previous launch — so it must run
  // before install() rewrites the runtime hooks.json.
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
    if (!parsed || getCodexCanonicalTrustPath(parsed.sourcePath) !== canonicalRuntimeHooksPath) {
      continue
    }
    const previous = provenance.get(normalizeHookTrustKeyForLookup(key))
    if (
      previous &&
      previous.trustedHash === state.trustedHash &&
      (previous.enabled ?? true) === (state.enabled ?? true)
    ) {
      // Orca wrote this entry and nothing touched it since — not an approval.
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
    // Why: never write trust for Orca's managed status hook into the user's
    // real config — mutating ~/.codex for Orca's own hooks is exactly what the
    // runtime CODEX_HOME isolation exists to prevent.
    if (!definition || !hook?.command || isManagedCommand(hook.command)) {
      continue
    }
    const runtimeEntry = createCodexHookTrustEntry(
      runtimeHooksPath,
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

// Why: the runtime layout differs from the system one (managed hook
// prepended, duplicates collapsed), so approvals map back by hook content —
// and one runtime hook can map to several identical system entries.
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
