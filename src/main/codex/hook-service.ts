/* eslint-disable max-lines -- Why: getStatus + install + remove all share the managed-command and trust-key derivation. Splitting would hide that the three operations must agree on group index, event label, and command bytes. */
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join, win32 as pathWin32 } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildManagedCommandHook,
  createManagedCommandMatcher,
  buildWindowsAgentHookCurlPostCommand,
  getSharedManagedScriptPath,
  hookDefinitionHasManagedCommand,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  readHooksJson,
  removeManagedCommands,
  wrapPosixHookCommand,
  wrapWindowsCmdHookCommand,
  writeHooksJson,
  writeManagedScript,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  readTextFileRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
import {
  buildPosixHookPayloadCapture,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue,
  POSIX_HOOK_STDIN_DRAIN_COMMAND
} from '../agent-hooks/hook-stdin-contract'
import {
  computeTrustKey,
  computeTrustedHash,
  escapeTomlString,
  getCodexCanonicalTrustPath,
  normalizeCodexProjectPathForLookup,
  normalizeHookTrustKeyForLookup,
  parseTrustKey,
  readHookTrustEntries,
  removeHookTrustEntries,
  upsertHookTrustEntriesInContent,
  upsertHookTrustEntries,
  writeConfigAtomically,
  type CodexEventLabel,
  type CodexHookTrustState,
  type CodexTrustEntry
} from './config-toml-trust'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'
import {
  createCodexWslRuntimeHookInstallPlan,
  type CodexWslRuntimeHookInstallPlan,
  type CodexWslRuntimeHookTarget,
  type WslCanonicalPathSettlement
} from './codex-wsl-hook-install-plan'
import {
  CODEX_HOOK_EVENT_LABEL,
  createCodexHookTrustEntry,
  getCodexHookTrustSignature,
  getCodexManagedScriptFileName
} from './codex-hook-identity'
import {
  promoteCodexRuntimeHookApprovalsToSystem,
  snapshotCodexRuntimeHookTrustProvenance
} from './hook-trust-promotion'

// Why: Pre/PostToolUse feed the live in-flight-tool readout; PermissionRequest exits with no decision so Codex still shows its approval UI while Orca flips the pane to waiting.
const CODEX_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop'
] as const

function getConfigPath(): string {
  return join(getOrcaManagedCodexHomePath(), 'hooks.json')
}

function writeCodexHooksJson(configPath: string, hooks: Record<string, HookDefinition[]>): void {
  // Why: Codex rejects unknown top-level hooks.json fields, so plugin bookkeeping like `_managed` must not survive Orca's rewrite.
  writeHooksJson(configPath, { hooks })
}

function getCodexConfigTomlPath(): string {
  return join(getOrcaManagedCodexHomePath(), 'config.toml')
}

// Why: managed-event subset of the shared label map; full mapping lives in codex-hook-identity.ts so promotion can't drift.
const CODEX_EVENT_LABEL: Record<(typeof CODEX_EVENTS)[number], CodexEventLabel> = {
  SessionStart: CODEX_HOOK_EVENT_LABEL.SessionStart!,
  UserPromptSubmit: CODEX_HOOK_EVENT_LABEL.UserPromptSubmit!,
  PreToolUse: CODEX_HOOK_EVENT_LABEL.PreToolUse!,
  PermissionRequest: CODEX_HOOK_EVENT_LABEL.PermissionRequest!,
  PostToolUse: CODEX_HOOK_EVENT_LABEL.PostToolUse!,
  Stop: CODEX_HOOK_EVENT_LABEL.Stop!
}

const CODEX_MANAGED_EVENT_LABELS = new Set<CodexEventLabel>(
  CODEX_EVENTS.map((eventName) => CODEX_EVENT_LABEL[eventName])
)

const CODEX_PLUGIN_ONLY_HOOK_PLACEHOLDERS = [
  '${CLAUDE_PLUGIN_ROOT}',
  '${CLAUDE_PLUGIN_DATA}',
  '${PLUGIN_ROOT}',
  '${PLUGIN_DATA}'
] as const

const LEGACY_ORCA_PROFILE_NAME = 'orca-agent-status'
const LEGACY_ORCA_PROFILE_BLOCK_START = '# BEGIN ORCA AGENT STATUS HOOKS'
const LEGACY_ORCA_PROFILE_BLOCK_END = '# END ORCA AGENT STATUS HOOKS'

type MirroredRuntimeUserHookTrustEntry = {
  entry: CodexTrustEntry
  enabled: boolean
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getCodexManagedScriptFileName())
}

function getManagedCommand(scriptPath: string): string {
  return process.platform === 'win32'
    ? wrapWindowsCmdHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

export { createCodexWslRuntimeHookInstallPlan }
export type { CodexWslRuntimeHookInstallPlan }

function wrapReadablePosixHookCommand(scriptPath: string): string {
  const quoted = `'${scriptPath.replaceAll("'", "'\\''")}'`
  // Why: WSL hooks are written from Windows over UNC where the exec bit is unreliable; a missing script must still own stdin.
  return `if [ -f ${quoted} ] && [ -r ${quoted} ]; then /bin/sh ${quoted}; else ${POSIX_HOOK_STDIN_DRAIN_COMMAND}; fi`
}

function getSystemConfigPath(): string {
  return join(getSystemCodexHomePath(), 'hooks.json')
}

function getSystemCodexConfigTomlPath(): string {
  return join(getSystemCodexHomePath(), 'config.toml')
}

function getLegacyCodexProfileTomlPath(): string {
  return join(getSystemCodexHomePath(), `${LEGACY_ORCA_PROFILE_NAME}.config.toml`)
}

function collectManagedTrustEntries(
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

function removeMatchingTrustEntries(configPath: string, entries: readonly CodexTrustEntry[]): void {
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

function removeStaleRuntimeHookTrustEntries(
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
  const canonicalRuntimeHooksPath = getCodexCanonicalTrustPath(runtimeHooksPath)
  const staleKeys: string[] = []
  for (const [key, state] of readHookTrustEntries(tomlPath)) {
    const parsed = parseTrustKey(key)
    if (!parsed || getCodexCanonicalTrustPath(parsed.sourcePath) !== canonicalRuntimeHooksPath) {
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

function commandUsesCodexPluginOnlyPlaceholder(command: string | undefined): boolean {
  return (
    typeof command === 'string' &&
    CODEX_PLUGIN_ONLY_HOOK_PLACEHOLDERS.some((placeholder) => command.includes(placeholder))
  )
}

function removeCodexPluginEnvironmentCommands(definitions: HookDefinition[]): HookDefinition[] {
  // Why: plugin placeholders only resolve for Codex plugin hook sources; mirroring them into a plain runtime hooks.json turns them into 127s.
  return removeManagedCommands(definitions, commandUsesCodexPluginOnlyPlaceholder)
}

function getRuntimeHooksWithSystemUserHooks(
  runtimeHooks: Record<string, HookDefinition[]> | undefined,
  isManagedCommand: (command: string | undefined) => boolean
): {
  hooks: Record<string, HookDefinition[]>
  trustEntries: MirroredRuntimeUserHookTrustEntry[]
} {
  const systemConfigPath = getSystemConfigPath()
  const runtimeConfigPath = getConfigPath()
  if (systemConfigPath === getConfigPath()) {
    return { hooks: { ...runtimeHooks }, trustEntries: [] }
  }

  const systemConfig = readHooksJson(systemConfigPath)
  if (!systemConfig?.hooks) {
    return { hooks: {}, trustEntries: [] }
  }

  const nextHooks: Record<string, HookDefinition[]> = {}
  const trustedSystemHookSignatures = getTrustedSystemUserHookSignatures(
    systemConfigPath,
    systemConfig.hooks,
    isManagedCommand
  )
  for (const [eventName, systemDefinitions] of Object.entries(systemConfig.hooks)) {
    if (!Array.isArray(systemDefinitions)) {
      continue
    }

    const systemUserDefinitions = removeCodexPluginEnvironmentCommands(
      removeManagedCommands(systemDefinitions, isManagedCommand)
    )
    if (systemUserDefinitions.length === 0) {
      continue
    }

    // Why: rebuild from system hooks; reusing old runtime copies would keep deleted/edited ~/.codex/hooks.json entries alive for new sessions.
    nextHooks[eventName] = dedupeHookDefinitions(systemUserDefinitions)
  }

  return {
    hooks: nextHooks,
    trustEntries: collectMirroredRuntimeUserHookTrustEntries(
      runtimeConfigPath,
      nextHooks,
      trustedSystemHookSignatures,
      isManagedCommand
    )
  }
}

type TrustedSystemHookSignatureState = {
  enabled: boolean
  trustedHash: string
}

function getTrustedSystemUserHookSignatures(
  systemConfigPath: string,
  systemHooks: Record<string, HookDefinition[]>,
  isManagedCommand: (command: string | undefined) => boolean
): Map<string, TrustedSystemHookSignatureState> {
  const signatures = new Map<string, TrustedSystemHookSignatureState>()
  let trustEntries: Map<string, CodexHookTrustState>
  try {
    trustEntries = readHookTrustEntries(getSystemCodexConfigTomlPath())
  } catch (error) {
    // Why: a hand-broken system config.toml should only disable user-hook trust mirroring, not block Orca's managed runtime hooks.
    console.warn('[codex-hook-service] failed to read system hook trust entries', error)
    return signatures
  }
  const trustedHashesByEvent = getTrustedSystemHookHashesByEvent(systemConfigPath, trustEntries)
  for (const [eventName, definitions] of Object.entries(systemHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    definitions.forEach((definition, groupIndex) => {
      const hooks = Array.isArray(definition.hooks) ? definition.hooks : []
      hooks.forEach((hook, handlerIndex) => {
        if (isManagedCommand(hook.command)) {
          return
        }
        const entry = createCodexHookTrustEntry(
          systemConfigPath,
          eventName,
          groupIndex,
          handlerIndex,
          definition,
          hook
        )
        if (!entry) {
          return
        }
        const state = resolveTrustedSystemHookState(entry, trustEntries, trustedHashesByEvent)
        if (!state) {
          return
        }
        const signature = getCodexHookTrustSignature(entry)
        // Why: runtime deduping collapses identical definitions; if any duplicate stays enabled, keep the mirrored hook enabled.
        if (state.enabled || !signatures.has(signature)) {
          signatures.set(signature, state)
        }
      })
    })
  }
  return signatures
}

function resolveTrustedSystemHookState(
  entry: CodexTrustEntry,
  trustEntries: ReadonlyMap<string, CodexHookTrustState>,
  trustedHashesByEvent: ReadonlyMap<CodexEventLabel, Map<string, boolean>>
): TrustedSystemHookSignatureState | null {
  const expectedHash = computeTrustedHash(entry)
  const state = trustEntries.get(computeTrustKey(entry))
  if (state?.trustedHash === expectedHash) {
    return { enabled: state.enabled !== false, trustedHash: expectedHash }
  }
  const reorderedEnabled = trustedHashesByEvent.get(entry.eventLabel)?.get(expectedHash)
  if (reorderedEnabled !== undefined) {
    return { enabled: reorderedEnabled, trustedHash: expectedHash }
  }
  if (state?.trustedHash) {
    // Why: carry a key-matched system hash verbatim — recomputing caused #7110 re-approval loops since Codex owns its hash algorithm.
    return { enabled: state.enabled !== false, trustedHash: state.trustedHash }
  }
  return null
}

function getTrustedSystemHookHashesByEvent(
  systemConfigPath: string,
  trustEntries: ReadonlyMap<string, CodexHookTrustState>
): Map<CodexEventLabel, Map<string, boolean>> {
  const trustedHashesByEvent = new Map<CodexEventLabel, Map<string, boolean>>()
  const canonicalSystemConfigPath = getCodexCanonicalTrustPath(systemConfigPath)
  for (const [key, state] of trustEntries) {
    const parsed = parseTrustKey(key)
    if (!parsed || !state.trustedHash) {
      continue
    }
    if (getCodexCanonicalTrustPath(parsed.sourcePath) !== canonicalSystemConfigPath) {
      continue
    }
    let hashes = trustedHashesByEvent.get(parsed.eventLabel)
    if (!hashes) {
      hashes = new Map()
      trustedHashesByEvent.set(parsed.eventLabel, hashes)
    }
    const enabled = state.enabled !== false
    // Why: Codex trust keys include hook indices, but the hash still proves the same event+command identity was approved after a reorder.
    if (enabled || !hashes.has(state.trustedHash)) {
      hashes.set(state.trustedHash, enabled)
    }
  }
  return trustedHashesByEvent
}

function collectMirroredRuntimeUserHookTrustEntries(
  runtimeConfigPath: string,
  runtimeHooks: Record<string, HookDefinition[]>,
  trustedSystemHookSignatures: ReadonlyMap<string, TrustedSystemHookSignatureState>,
  isManagedCommand: (command: string | undefined) => boolean
): MirroredRuntimeUserHookTrustEntry[] {
  if (trustedSystemHookSignatures.size === 0) {
    return []
  }

  const entries: MirroredRuntimeUserHookTrustEntry[] = []
  for (const [eventName, definitions] of Object.entries(runtimeHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    definitions.forEach((definition, groupIndex) => {
      const hooks = Array.isArray(definition.hooks) ? definition.hooks : []
      hooks.forEach((hook, handlerIndex) => {
        if (isManagedCommand(hook.command)) {
          return
        }
        const entry = createCodexHookTrustEntry(
          runtimeConfigPath,
          eventName,
          groupIndex,
          handlerIndex,
          definition,
          hook
        )
        if (!entry) {
          return
        }
        const signature = getCodexHookTrustSignature(entry)
        const state = trustedSystemHookSignatures.get(signature)
        if (state !== undefined) {
          entries.push({
            entry: { ...entry, trustedHash: state.trustedHash },
            enabled: state.enabled
          })
        }
      })
    })
  }
  return entries
}

function moveMirroredRuntimeUserTrustAfterManagedStatusHook(
  entries: readonly MirroredRuntimeUserHookTrustEntry[]
): MirroredRuntimeUserHookTrustEntry[] {
  return entries.map(({ entry, enabled }) => {
    if (!CODEX_MANAGED_EVENT_LABELS.has(entry.eventLabel)) {
      return { entry, enabled }
    }
    return {
      entry: { ...entry, groupIndex: entry.groupIndex + 1 },
      enabled
    }
  })
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildHookTrustHeaderKeyPattern(key: string): string {
  const keyVariants = [key]
  const parsed = parseTrustKey(key)
  if (parsed && /^[A-Za-z]:[\\/]|^\\\\/.test(parsed.sourcePath)) {
    const suffix = `:${parsed.eventLabel}:${parsed.groupIndex}:${parsed.handlerIndex}`
    keyVariants.push(
      `${parsed.sourcePath.replace(/\\/g, '/')}${suffix}`,
      `${parsed.sourcePath.replace(/\//g, '\\')}${suffix}`
    )
  }
  const alternatives = [...new Set(keyVariants)].flatMap((variant) => {
    const quoted = [`"${escapeRegex(escapeTomlString(variant))}"`]
    if (!variant.includes("'")) {
      // Why: tolerate raw-backslash literal keys from Codex/manual approval while repairing mirrored runtime trust across both Windows variants.
      quoted.push(`'${escapeRegex(variant)}'`)
    }
    return quoted
  })
  return `(?:${alternatives.join('|')})`
}

function applyMirroredRuntimeUserHookTrustStates(
  tomlPath: string,
  entries: readonly MirroredRuntimeUserHookTrustEntry[]
): void {
  if (entries.length === 0 || !existsSync(tomlPath)) {
    return
  }

  const existing = readFileSync(tomlPath, 'utf-8')
  let updated = existing
  for (const { entry, enabled } of entries) {
    const headerKeyPattern = buildHookTrustHeaderKeyPattern(computeTrustKey(entry))
    const pattern = new RegExp(
      `(\\[hooks\\.state\\.${headerKeyPattern}\\]\\r?\\n[ \\t]*enabled[ \\t]*=[ \\t]*)(true|false)`,
      'g'
    )
    updated = updated.replace(pattern, `$1${enabled}`)
  }
  if (updated !== existing) {
    writeConfigAtomically(tomlPath, updated)
  }
}

function dedupeHookDefinitions(definitions: readonly HookDefinition[]): HookDefinition[] {
  const seen = new Set<string>()
  return definitions.filter((definition) => {
    const key = JSON.stringify(definition)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function cleanupLegacySystemManagedHooks(): void {
  const legacyConfigPath = getSystemConfigPath()
  const runtimeConfigPath = getConfigPath()
  if (legacyConfigPath === runtimeConfigPath) {
    return
  }

  const config = readHooksJson(legacyConfigPath)
  if (!config?.hooks) {
    return
  }

  const isManagedCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
  const nextHooks = { ...config.hooks }
  const trustEntries: CodexTrustEntry[] = []
  let removedManagedHook = false
  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    const eventTrustEntries = collectManagedTrustEntries(
      legacyConfigPath,
      eventName,
      definitions,
      isManagedCommand
    )
    // Why: user hook configs can be large; avoid the argument limit from push(...entries).
    for (const entry of eventTrustEntries) {
      trustEntries.push(entry)
    }
    const cleaned = removeManagedCommands(definitions, isManagedCommand)
    removedManagedHook ||= definitions.some((definition) =>
      hookDefinitionHasManagedCommand(definition, isManagedCommand)
    )
    if (cleaned.length === 0) {
      delete nextHooks[eventName]
    } else {
      nextHooks[eventName] = cleaned
    }
  }

  // Why: Codex hooks moved to Orca's managed CODEX_HOME; stale ~/.codex entries would keep external Codex sessions reporting into Orca.
  if (removedManagedHook) {
    // Why: this is the user's system hooks file, not Orca's runtime copy; remove only stale Orca entries and preserve other managers' metadata.
    writeHooksJson(legacyConfigPath, { ...config, hooks: nextHooks })
  }
  removeMatchingTrustEntries(getSystemCodexConfigTomlPath(), trustEntries)
}

function stripLegacyManagedProfileBlock(content: string): string {
  const start = content.indexOf(LEGACY_ORCA_PROFILE_BLOCK_START)
  if (start === -1) {
    return content
  }
  const endMarker = content.indexOf(LEGACY_ORCA_PROFILE_BLOCK_END, start)
  const end = endMarker === -1 ? content.length : endMarker + LEGACY_ORCA_PROFILE_BLOCK_END.length
  const before = content.slice(0, start).replace(/[ \t]*(?:\r?\n)*$/, '')
  const after = content.slice(end).replace(/^(?:\r?\n)+/, '')
  if (!before) {
    return after
  }
  if (!after) {
    return before.endsWith('\n') ? before : `${before}\n`
  }
  return `${before}\n\n${after}`
}

function cleanupLegacyCodexProfileHooks(): void {
  const profilePath = getLegacyCodexProfileTomlPath()
  if (!existsSync(profilePath)) {
    return
  }

  const existing = readFileSync(profilePath, 'utf-8')
  const next = stripLegacyManagedProfileBlock(existing)
  if (next === existing) {
    return
  }
  // Why: #2778 wrote Orca hooks into a Codex profile file; runtime CODEX_HOME supersedes it, so remove only Orca's marked block.
  if (next.trim().length === 0) {
    unlinkSync(profilePath)
  } else {
    writeConfigAtomically(profilePath, next)
  }
}

function cleanupLegacyManagedHookRepresentations(): void {
  try {
    cleanupLegacySystemManagedHooks()
    cleanupLegacyCodexProfileHooks()
  } catch (error) {
    console.warn('[codex-hook-service] failed to clean legacy Codex hooks', error)
  }
}

function removeRuntimeManagedHookTrustEntries(configPath: string): void {
  try {
    const tomlPath = getCodexConfigTomlPath()
    const existingEntries = readHookTrustEntries(tomlPath)
    const scriptPath = getManagedScriptPath()
    const command = getManagedCommand(scriptPath)
    const managedEventLabels = new Set<CodexEventLabel>(
      CODEX_EVENTS.map((event) => CODEX_EVENT_LABEL[event])
    )
    // Why: drop only entries we wrote — match by hash to our managed command, since a sourcePath-only filter would wipe user-approved non-Orca entries.
    const ourKeys: string[] = []
    const canonicalConfigPath = getCodexCanonicalTrustPath(configPath)
    for (const [key, state] of existingEntries) {
      const parts = parseTrustKey(key)
      if (parts === null) {
        continue
      }
      if (getCodexCanonicalTrustPath(parts.sourcePath) !== canonicalConfigPath) {
        continue
      }
      if (!managedEventLabels.has(parts.eventLabel)) {
        continue
      }
      const expectedEntry: CodexTrustEntry = {
        sourcePath: configPath,
        eventLabel: parts.eventLabel,
        groupIndex: parts.groupIndex,
        handlerIndex: parts.handlerIndex,
        command,
        // Why: match the timeout install() wrote, or remove() can't recognize and clean up its own managed trust entries.
        timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
      }
      const recognizedHashes = new Set([
        computeTrustedHash(expectedEntry),
        computeTrustedHash({ ...expectedEntry, timeoutSec: undefined })
      ])
      if (!state.trustedHash || !recognizedHashes.has(state.trustedHash)) {
        continue
      }
      ourKeys.push(key)
    }
    if (ourKeys.length > 0) {
      removeHookTrustEntries(tomlPath, ourKeys)
    }
  } catch (error) {
    // Best effort — stale trust is harmless once hooks.json no longer references the hook; log so a programmer error isn't silent.
    console.warn('[codex-hook-service] failed to clean trust entries', error)
  }
}

function removeWslRuntimeManagedHookTrustEntries(plan: CodexWslRuntimeHookInstallPlan): void {
  try {
    const existingEntries = readHookTrustEntries(plan.tomlPath)
    const command = wrapReadablePosixHookCommand(plan.commandScriptPath)
    const managedEventLabels = new Set<CodexEventLabel>(
      CODEX_EVENTS.map((event) => CODEX_EVENT_LABEL[event])
    )
    const canonicalConfigPath = getCodexCanonicalTrustPath(plan.trustConfigPath)
    const ourKeys: string[] = []
    for (const [key, state] of existingEntries) {
      const parts = parseTrustKey(key)
      if (parts === null) {
        continue
      }
      if (getCodexCanonicalTrustPath(parts.sourcePath) !== canonicalConfigPath) {
        continue
      }
      if (!managedEventLabels.has(parts.eventLabel)) {
        continue
      }
      const expectedEntry: CodexTrustEntry = {
        sourcePath: plan.trustConfigPath,
        eventLabel: parts.eventLabel,
        groupIndex: parts.groupIndex,
        handlerIndex: parts.handlerIndex,
        command,
        timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
      }
      const recognizedHashes = new Set([
        computeTrustedHash(expectedEntry),
        computeTrustedHash({ ...expectedEntry, timeoutSec: undefined })
      ])
      if (state.trustedHash && recognizedHashes.has(state.trustedHash)) {
        ourKeys.push(key)
      }
    }
    if (ourKeys.length > 0) {
      removeHookTrustEntries(plan.tomlPath, ourKeys)
    }
  } catch (error) {
    // Why: best-effort like host cleanup; stale trust is inert once hooks.json no longer points at us.
    console.warn('[codex-hook-service] failed to clean WSL trust entries', error)
  }
}

function removeStaleWslRuntimeManagedHookTrustEntries(
  tomlPath: string,
  desiredEntries: readonly CodexTrustEntry[]
): void {
  const desiredKeys = new Set(
    desiredEntries.map((entry) => normalizeHookTrustKeyForLookup(computeTrustKey(entry)))
  )
  const existingEntries = readHookTrustEntries(tomlPath)
  const ourKeys: string[] = []
  for (const [key, state] of existingEntries) {
    if (desiredKeys.has(normalizeHookTrustKeyForLookup(key))) {
      continue
    }
    const parts = parseTrustKey(key)
    if (!parts || !CODEX_MANAGED_EVENT_LABELS.has(parts.eventLabel)) {
      continue
    }
    const sourcePath = parts.sourcePath
    // Why: this cleanup owns only guest-side WSL trust; leave any user Windows/remote hooks in the runtime config untouched.
    if (!sourcePath.startsWith('/') || !sourcePath.endsWith('/hooks.json')) {
      continue
    }
    const runtimeHome = sourcePath.slice(0, -'/hooks.json'.length)
    const command = wrapReadablePosixHookCommand(`${runtimeHome}/.orca/agent-hooks/codex-hook.sh`)
    const expectedEntry: CodexTrustEntry = {
      sourcePath: parts.sourcePath,
      eventLabel: parts.eventLabel,
      groupIndex: parts.groupIndex,
      handlerIndex: parts.handlerIndex,
      command,
      timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
    }
    const recognizedHashes = new Set([
      computeTrustedHash(expectedEntry),
      computeTrustedHash({ ...expectedEntry, timeoutSec: undefined })
    ])
    if (state.trustedHash && recognizedHashes.has(state.trustedHash)) {
      ourKeys.push(key)
    }
  }
  if (ourKeys.length > 0) {
    removeHookTrustEntries(tomlPath, ourKeys)
  }
}

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: the endpoint file holds this install's live port/token; sourcing it lets a surviving PTY reach the current server (see claude/hook-service.ts).
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookCurlPostCommand('codex'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    // Why: sourcing refreshes PORT/TOKEN/ENV/VERSION from the current Orca so a surviving PTY keeps reporting after a restart (see claude/hook-service.ts).
    'load_hook_endpoint() {',
    '  endpoint_path="$1"',
    '  case "$endpoint_path" in',
    '    *.cmd)',
    // Why: Windows passes endpoint.cmd into WSL via WSLENV; parse only Orca's known assignments since cmd.exe `set` lines aren't shell syntax.
    '      endpoint_cr=$(printf "\\r")',
    '      while IFS= read -r endpoint_line || [ -n "$endpoint_line" ]; do',
    '        endpoint_line=${endpoint_line%"$endpoint_cr"}',
    '        case "$endpoint_line" in',
    '          "set ORCA_AGENT_HOOK_PORT="*) ORCA_AGENT_HOOK_PORT=${endpoint_line#*=} ;;',
    '          "set ORCA_AGENT_HOOK_TOKEN="*) ORCA_AGENT_HOOK_TOKEN=${endpoint_line#*=} ;;',
    '          "set ORCA_AGENT_HOOK_ENV="*) ORCA_AGENT_HOOK_ENV=${endpoint_line#*=} ;;',
    '          "set ORCA_AGENT_HOOK_VERSION="*) ORCA_AGENT_HOOK_VERSION=${endpoint_line#*=} ;;',
    '        esac',
    '      done < "$endpoint_path"',
    '      ;;',
    '    *)',
    '      . "$endpoint_path" 2>/dev/null || :',
    '      ;;',
    '  esac',
    '}',
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  load_hook_endpoint "$ORCA_AGENT_HOOK_ENDPOINT"',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    'post_codex_hook() {',
    '  curl_bin="$1"',
    '  connect_timeout="${2:-0.5}"',
    '  max_time="${3:-1.5}"',
    // Why: worktreeId embeds a path, so hand-building JSON in shell is unsafe with quotes/newlines; post raw payload plus metadata as form fields instead.
    // Why: pipe payload to curl's stdin (`payload@-`) not an inline arg, so tens-of-KB tool output stays off the command line (EDR false positives).
    '  printf \'%s\' "$payload" | "$curl_bin" -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/codex" \\',
    '    --connect-timeout "$connect_timeout" --max-time "$max_time" \\',
    '    --noproxy "127.0.0.1" \\',
    '    -H "Content-Type: application/x-www-form-urlencoded" \\',
    '    -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '    --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '    --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '    --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '    --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '    --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '    --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '    --data-urlencode "payload@-"',
    '}',
    'is_wsl_runtime() {',
    '  [ -n "$WSL_DISTRO_NAME" ] && return 0',
    '  grep -qiE "microsoft|wsl" /proc/sys/kernel/osrelease /proc/version 2>/dev/null',
    '}',
    'if post_codex_hook curl >/dev/null 2>&1; then',
    '  exit 0',
    'fi',
    'if is_wsl_runtime; then',
    '  windows_curl=$(command -v curl.exe 2>/dev/null || true)',
    '  if [ -n "$windows_curl" ] && [ -x "$windows_curl" ]; then',
    '    post_codex_hook "$windows_curl" 3 5 >/dev/null 2>&1 || true',
    '  fi',
    'fi',
    'exit 0',
    ''
  ].join('\n')
}

function installManagedHooksIntoWslRuntime(
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
    const definition: HookDefinition = {
      hooks: [buildManagedCommandHook(command)]
    }
    nextHooks[eventName] = [definition, ...cleaned]
    trustEntries.push({
      sourcePath: plan.trustConfigPath,
      eventLabel: CODEX_EVENT_LABEL[eventName],
      groupIndex: 0,
      handlerIndex: 0,
      command,
      timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
    })
  }

  config.hooks = nextHooks
  writeManagedScript(plan.scriptPath, getManagedScript('posix'))
  writeCodexHooksJson(plan.configPath, nextHooks)
  try {
    // Why: WSL runtime homes may carry user hook approvals we didn't rebuild; upsert only Orca's entries instead of sweeping the whole source.
    upsertHookTrustEntries(plan.tomlPath, trustEntries)
    removeStaleWslRuntimeManagedHookTrustEntries(plan.tomlPath, trustEntries)
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

function refreshWslRuntimeUserHooks(plan: CodexWslRuntimeHookInstallPlan): AgentHookInstallStatus {
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
function getWslHookReconciliationAction(args: {
  settlement: WslCanonicalPathSettlement
  isCurrentGeneration: boolean
  installedTrustConfigPath: string | null
  resolvedTrustConfigPath: string | null
}): 'none' | 'remove' | 'reinstall' {
  if (!args.isCurrentGeneration) {
    return 'none'
  }
  if (args.settlement.status === 'missing') {
    return 'remove'
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
function getWslReconciliationKey(runtimeHomePath: string): string {
  return normalizeCodexProjectPathForLookup(runtimeHomePath)
}

export class CodexHookService {
  private readonly wslReconciliationGeneration = new Map<string, number>()

  private supersedeWslReconciliation(runtimeHomePath: string | null | undefined): number {
    if (!runtimeHomePath) {
      return 0
    }
    const key = getWslReconciliationKey(runtimeHomePath)
    const generation = (this.wslReconciliationGeneration.get(key) ?? 0) + 1
    this.wslReconciliationGeneration.set(key, generation)
    return generation
  }

  installForRuntimeHome(
    runtimeHomePath: string | null | undefined,
    target?: CodexWslRuntimeHookTarget
  ): AgentHookInstallStatus | null {
    const generation = this.supersedeWslReconciliation(runtimeHomePath)
    let installedTrustConfigPath: string | null = null
    const onCanonicalPathSettled = (settlement: WslCanonicalPathSettlement): void => {
      if (!runtimeHomePath) {
        return
      }
      const key = getWslReconciliationKey(runtimeHomePath)
      const resolvedPlan =
        settlement.status === 'resolved'
          ? createCodexWslRuntimeHookInstallPlan(
              runtimeHomePath,
              target,
              () => settlement.canonicalPath
            )
          : null
      const action = getWslHookReconciliationAction({
        settlement,
        isCurrentGeneration: this.wslReconciliationGeneration.get(key) === generation,
        installedTrustConfigPath,
        resolvedTrustConfigPath: resolvedPlan?.trustConfigPath ?? null
      })
      if (action === 'none') {
        return
      }
      if (action === 'remove') {
        try {
          removeStaleWslRuntimeManagedHookTrustEntries(
            pathWin32.join(runtimeHomePath, 'config.toml'),
            []
          )
        } catch (error) {
          console.warn('[codex-hook-service] failed to revoke stale WSL hook trust', error)
        }
        return
      }
      if (!resolvedPlan) {
        return
      }
      const status = installManagedHooksIntoWslRuntime(resolvedPlan)
      if (status.state === 'error') {
        console.warn('[codex-hook-service] failed to reconcile WSL hook path', status.detail)
        return
      }
      installedTrustConfigPath = resolvedPlan.trustConfigPath
    }
    const wslPlan = createCodexWslRuntimeHookInstallPlan(
      runtimeHomePath,
      target,
      undefined,
      onCanonicalPathSettled
    )
    installedTrustConfigPath = wslPlan?.trustConfigPath ?? null
    return wslPlan ? installManagedHooksIntoWslRuntime(wslPlan) : null
  }

  refreshRuntimeUserHooksForRuntimeHome(
    runtimeHomePath: string | null | undefined,
    target?: CodexWslRuntimeHookTarget
  ): AgentHookInstallStatus | null {
    this.supersedeWslReconciliation(runtimeHomePath)
    const wslPlan = createCodexWslRuntimeHookInstallPlan(runtimeHomePath, target)
    return wslPlan ? refreshWslRuntimeUserHooks(wslPlan) : null
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
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
    const tomlPath = getCodexConfigTomlPath()
    // Why: an unreadable config.toml (EACCES/EIO) differs from "absent" (empty Map); hooks.json may be fine, so report partial with a specific reason.
    let trustEntries: Map<string, CodexHookTrustState>
    let trustReadError: string | null = null
    try {
      trustEntries = readHookTrustEntries(tomlPath)
    } catch (error) {
      trustEntries = new Map()
      trustReadError = error instanceof Error ? error.message : String(error)
    }

    const missing: string[] = []
    const trustMissing: string[] = []
    const disabled: string[] = []
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
        sourcePath: configPath,
        eventLabel: CODEX_EVENT_LABEL[eventName],
        groupIndex: foundGroupIndex,
        handlerIndex: foundHandlerIndex,
        command,
        timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
      }
      const expectedHash = computeTrustedHash(trustInput)
      const actualState = trustEntries.get(computeTrustKey(trustInput))
      if (actualState?.trustedHash !== expectedHash) {
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

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    // Why: run before install rewrites hooks.json/config.toml, since stale-trust cleanup would delete in-Orca approvals keyed to the prior layout.
    promoteCodexRuntimeHookApprovalsToSystem()
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
    const hookPlan = getRuntimeHooksWithSystemUserHooks(config.hooks, isManagedCommand)
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
    const trustEntries: CodexTrustEntry[] = mirroredUserTrustEntries.map(({ entry }) => entry)
    for (const eventName of CODEX_EVENTS) {
      const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
      const cleaned = removeManagedCommands(current, isManagedCommand)
      const definition: HookDefinition = {
        hooks: [buildManagedCommandHook(command)]
      }
      nextHooks[eventName] = [definition, ...cleaned]
      // Why: status hook runs before user hooks so a slow PostToolUse/Stop hook can't leave the sidebar stuck on the previous state.
      // Why: timeoutSec mirrors the hook's `timeout` so the trust hash matches the entry written to hooks.json.
      trustEntries.push({
        sourcePath: configPath,
        eventLabel: CODEX_EVENT_LABEL[eventName],
        groupIndex: 0,
        handlerIndex: 0,
        command,
        timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
      })
    }

    config.hooks = nextHooks
    writeManagedScript(scriptPath, getManagedScript())
    writeCodexHooksJson(configPath, nextHooks)
    // Why: trust entries write last so a half-write can't leave a hash pointing at a nonexistent hook.
    // Why: surface trust-write failures — otherwise getStatus reports green for a hook Codex won't fire.
    try {
      const tomlPath = getCodexConfigTomlPath()
      syncSystemConfigIntoManagedCodexHome()
      // Why: don't let revoked ~/.codex approvals survive as stale runtime trust; upsert before cleanup to preserve a disabled managed copy.
      upsertHookTrustEntries(tomlPath, trustEntries)
      removeStaleRuntimeHookTrustEntries(tomlPath, configPath, trustEntries)
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
    snapshotCodexRuntimeHookTrustProvenance()
    try {
      cleanupLegacySystemManagedHooks()
      cleanupLegacyCodexProfileHooks()
    } catch (error) {
      console.warn('[codex-hook-service] failed to clean legacy Codex hooks', error)
    }
    return this.getStatus()
  }

  async installRemote(
    sftp: SFTPWrapper,
    remoteHome: string,
    options?: {
      /** Explicit CODEX_HOME dir (flat layout). WSL sessions read Orca's managed runtime home, not ~/.codex, so the default location leaves them hookless. */
      codexHomeDir?: string
      /** Skip the trust write when config.toml is absent — the WSL launch path seeds it only-if-absent, so creating it here would cancel that seed. */
      deferTrustUntilConfigToml?: boolean
    }
  ): Promise<AgentHookInstallStatus> {
    const codexHomeBase =
      options?.codexHomeDir?.replace(/\/$/, '') ?? `${remoteHome.replace(/\/$/, '')}/.codex`
    const remoteConfigPath = `${codexHomeBase}/hooks.json`
    const remoteTomlPath = `${codexHomeBase}/config.toml`
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/codex-hook.sh`
    try {
      const config = await readHooksJsonRemote(sftp, remoteConfigPath)
      if (!config) {
        return {
          agent: 'codex',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote Codex hooks.json'
        }
      }

      const command = wrapPosixHookCommand(remoteScriptPath)
      const nextHooks = { ...config.hooks }
      const managedEvents = new Set<string>(CODEX_EVENTS)
      const isManagedCommand = createManagedCommandMatcher('codex-hook.sh')

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
        const definition: HookDefinition = {
          hooks: [buildManagedCommandHook(command)]
        }
        nextHooks[eventName] = [...cleaned, definition]
        trustEntries.push({
          sourcePath: remoteConfigPath,
          eventLabel: CODEX_EVENT_LABEL[eventName],
          groupIndex: cleaned.length,
          handlerIndex: 0,
          command,
          timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
        })
      }

      config.hooks = nextHooks
      // Why: write script/settings before trust TOML; a partial trust write leaves Codex asking approval instead of running a missing script.
      // Why: SSH remotes use POSIX `.sh` paths even when Orca runs on Windows; never derive remote script syntax from local OS.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      // Why: SSH edits the user's remote ~/.codex/hooks.json directly, so preserve non-Orca top-level metadata while replacing the hooks tree.
      await writeHooksJsonRemote(sftp, remoteConfigPath, { ...config, hooks: nextHooks })
      try {
        const existingTomlRaw = await readTextFileRemote(sftp, remoteTomlPath)
        if (existingTomlRaw === null && options?.deferTrustUntilConfigToml === true) {
          return {
            agent: 'codex',
            state: 'installed',
            configPath: remoteConfigPath,
            managedHooksPresent: true,
            detail: 'Trust entries deferred until config.toml is seeded by the launch path'
          }
        }
        const existingToml = existingTomlRaw ?? ''
        const updatedToml = upsertHookTrustEntriesInContent(existingToml, trustEntries)
        if (updatedToml !== existingToml) {
          await writeTextFileRemoteAtomic(sftp, remoteTomlPath, updatedToml)
        }
      } catch (error) {
        return {
          agent: 'codex',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: true,
          detail: `Hooks installed but trust entries could not be written: ${
            error instanceof Error ? error.message : String(error)
          }. Run /hooks in Codex on the remote host to approve.`
        }
      }

      return {
        agent: 'codex',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'codex',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }

  refreshRuntimeUserHooks(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    // Why: capture in-Orca approvals before this refresh rewrites the runtime files they are keyed against.
    promoteCodexRuntimeHookApprovalsToSystem()
    const config = readHooksJson(configPath)
    if (!config) {
      // Why: disabled launch prep once called remove(); preserve that legacy cleanup even when runtime hooks.json is malformed.
      cleanupLegacyManagedHookRepresentations()
      return {
        agent: 'codex',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Codex hooks.json'
      }
    }

    const isManagedCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
    const hookPlan = getRuntimeHooksWithSystemUserHooks(config.hooks, isManagedCommand)
    config.hooks = hookPlan.hooks
    writeCodexHooksJson(configPath, hookPlan.hooks)

    try {
      const tomlPath = getCodexConfigTomlPath()
      const trustEntries = hookPlan.trustEntries.map(({ entry }) => entry)
      syncSystemConfigIntoManagedCodexHome()
      // Why: disabled path keeps user hooks but not managed trust; write mirrored trust first so stale cleanup compares against current hashes.
      upsertHookTrustEntries(tomlPath, trustEntries)
      removeStaleRuntimeHookTrustEntries(tomlPath, configPath, trustEntries)
      applyMirroredRuntimeUserHookTrustStates(tomlPath, hookPlan.trustEntries)
    } catch (error) {
      return {
        agent: 'codex',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: `User hooks refreshed but trust entries could not be written: ${error instanceof Error ? error.message : String(error)}. Run /hooks in Codex to approve.`
      }
    }
    snapshotCodexRuntimeHookTrustProvenance()

    cleanupLegacyManagedHookRepresentations()
    return this.getStatus()
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const configExists = existsSync(configPath)
    const config = readHooksJson(configPath)
    if (!config) {
      // Why: a malformed hooks.json shouldn't strand old hooks in ~/.codex or the legacy profile after disabling.
      cleanupLegacyManagedHookRepresentations()
      return {
        agent: 'codex',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Codex hooks.json'
      }
    }

    const nextHooks = { ...config.hooks }
    // Why: same broad matcher as install() so stale entries from older builds get cleaned even if scriptPath moved.
    const isManagedCommand = createManagedCommandMatcher(getCodexManagedScriptFileName())
    for (const [eventName, definitions] of Object.entries(nextHooks)) {
      if (!Array.isArray(definitions)) {
        // Why: a non-array event value would make removeManagedCommands throw; skip it.
        continue
      }
      const cleaned = removeManagedCommands(definitions, isManagedCommand)
      if (cleaned.length === 0) {
        delete nextHooks[eventName]
      } else {
        nextHooks[eventName] = cleaned
      }
    }
    if (configExists) {
      // Why: remove() may be the only repair path for a file whose top-level plugin metadata makes Codex reject hooks.json.
      writeCodexHooksJson(configPath, nextHooks)
    }

    // Why: drop trust entries so config.toml doesn't accumulate dead [hooks.state] blocks across install/remove cycles.
    removeRuntimeManagedHookTrustEntries(configPath)

    cleanupLegacyManagedHookRepresentations()

    return this.getStatus()
  }
}

export const codexHookService = new CodexHookService()

export const _internals = {
  getManagedScript,
  installManagedHooksIntoWslRuntime,
  refreshWslRuntimeUserHooks,
  removeStaleWslRuntimeManagedHookTrustEntries,
  getWslHookReconciliationAction
}
