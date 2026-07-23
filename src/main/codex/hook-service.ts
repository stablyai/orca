/* eslint-disable max-lines -- Why: getStatus + install + remove all share the managed-command and trust-key derivation. Splitting would hide that the three operations must agree on group index, event label, and command bytes. */
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
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
  readHooksJsonWithRaw,
  removeManagedCommands,
  wrapPosixHookCommand,
  wrapWindowsCmdHookCommand,
  writeHooksJson,
  writeManagedScript,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
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
  codexHookSourcePathsEqual,
  computeTrustKey,
  computeTrustedHash,
  escapeTomlString,
  getCodexExplicitHomeHookSourcePath,
  normalizeCodexHookSourcePath,
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
import { grantManagedCodexHookTrust } from './codex-hook-trust-grant'
import { readCurrentCodexTrustGrantLedgerHome } from './codex-trust-grant-host'
import {
  getCodexLedgerTrustedHash,
  readCodexTrustGrantLedgerHomeForReconciliation,
  removeCodexManagedHookTrustEntries,
  removeStaleWslCodexManagedHookTrustEntries
} from './codex-managed-trust-reconciliation'
import type { CodexTrustGrantLedgerHome } from './codex-trust-grant-ledger'
import { mutateRealHomeHooksPreservingUserTrust } from './codex-user-hook-trust-rebase'

// Why: Pre/PostToolUse feed the live in-flight-tool readout; PermissionRequest exits with no decision so Codex still shows its approval UI while Orca flips the pane to waiting.
const CODEX_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop'
] as const

function getConfigPath(runtimeHomePath: string = getOrcaManagedCodexHomePath()): string {
  return join(runtimeHomePath, 'hooks.json')
}

function writeCodexHooksJson(configPath: string, hooks: Record<string, HookDefinition[]>): void {
  // Why: Codex rejects unknown top-level hooks.json fields, so plugin bookkeeping like `_managed` must not survive Orca's rewrite.
  writeHooksJson(configPath, { hooks })
}

function getCodexConfigTomlPath(runtimeHomePath: string = getOrcaManagedCodexHomePath()): string {
  return join(runtimeHomePath, 'config.toml')
}

// Why: managed-event subset of the shared label map; full mapping lives in codex-hook-identity.ts so promotion can't drift.
const CODEX_EVENT_LABEL: Record<(typeof CODEX_EVENTS)[number], CodexEventLabel> = {
  SessionStart: CODEX_HOOK_EVENT_LABEL.SessionStart!,
  UserPromptSubmit: CODEX_HOOK_EVENT_LABEL.UserPromptSubmit!,
  PreToolUse: CODEX_HOOK_EVENT_LABEL.PreToolUse!,
  PermissionRequest: CODEX_HOOK_EVENT_LABEL.PermissionRequest!,
  PostToolUse: CODEX_HOOK_EVENT_LABEL.PostToolUse!,
  SubagentStart: CODEX_HOOK_EVENT_LABEL.SubagentStart!,
  SubagentStop: CODEX_HOOK_EVENT_LABEL.SubagentStop!,
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

export type CodexManagedHookInstallMaterial = {
  events: readonly (typeof CODEX_EVENTS)[number][]
  eventLabel: Record<(typeof CODEX_EVENTS)[number], CodexEventLabel>
  scriptPath: string
  command: string
  script: string
}

// Why: the real-home installer must byte-match the managed lane's events,
// command, and script, or trust signatures diverge between the two homes.
export function getCodexManagedHookInstallMaterial(): CodexManagedHookInstallMaterial {
  const scriptPath = getManagedScriptPath()
  return {
    events: CODEX_EVENTS,
    eventLabel: CODEX_EVENT_LABEL,
    scriptPath,
    command: getManagedCommand(scriptPath),
    script: getManagedScript()
  }
}

// Why: when the real-home lane owns ~/.codex/hooks.json (system-default flag ON
// with hooks enabled), the legacy system-home sweep must stand down or every
// managed install would delete the entry the real-home installer just wrote.
// Injected as a gate because this module is bundled into plain-node CLI entries
// that have no settings store; the CLI default keeps the sweep active.
let systemCodexHomeHookSweepSuppressed: () => boolean = () => false

export function setSystemCodexHomeHookSweepSuppressed(gate: () => boolean): void {
  systemCodexHomeHookSweepSuppressed = gate
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

function removeSelfComputedMatchingTrustEntries(
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
  isManagedCommand: (command: string | undefined) => boolean,
  runtimeConfigPath: string = getConfigPath()
): {
  hooks: Record<string, HookDefinition[]>
  trustEntries: MirroredRuntimeUserHookTrustEntry[]
} {
  const systemConfigPath = getSystemConfigPath()
  if (systemConfigPath === runtimeConfigPath) {
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
  const canonicalSystemConfigPath = normalizeCodexHookSourcePath(systemConfigPath)
  for (const [key, state] of trustEntries) {
    const parsed = parseTrustKey(key)
    if (!parsed || !state.trustedHash) {
      continue
    }
    if (!codexHookSourcePathsEqual(parsed.sourcePath, canonicalSystemConfigPath)) {
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
  const trustSourcePath = getCodexExplicitHomeHookSourcePath(runtimeConfigPath)
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
          trustSourcePath,
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

function removeSystemManagedHookTrustEntries(systemHomePath: string, hooksJsonPath: string): void {
  removeCodexManagedHookTrustEntries({
    tomlPath: getSystemCodexConfigTomlPath(),
    runtimeHomePath: systemHomePath,
    sourcePath: hooksJsonPath,
    command: getManagedCommand(getManagedScriptPath()),
    managedEventLabels: CODEX_MANAGED_EVENT_LABELS,
    timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
  })
}

function cleanupLegacySystemManagedHooks(): void {
  if (systemCodexHomeHookSweepSuppressed()) {
    return
  }
  const legacyConfigPath = getSystemConfigPath()
  const runtimeConfigPath = getConfigPath()
  if (legacyConfigPath === runtimeConfigPath) {
    return
  }

  const systemHomePath = getSystemCodexHomePath()
  const hasRecordedRealHomeGrant =
    readCodexTrustGrantLedgerHomeForReconciliation(systemHomePath) !== null
  // Why: the pre-write guard below compares against these bytes; a separate
  // later read would let a concurrent save land between parse and snapshot.
  const { raw: previousRaw, config } = readHooksJsonWithRaw(legacyConfigPath)
  if (!config?.hooks || previousRaw === null) {
    if (hasRecordedRealHomeGrant) {
      removeSystemManagedHookTrustEntries(systemHomePath, legacyConfigPath)
    }
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
    // Why: this is the user's system hooks file, not Orca's runtime copy.
    // Remove only stale Orca hook entries and preserve other managers' metadata.
    const hooksWritePath = resolveHooksJsonWritePath(legacyConfigPath)
    const previousMode = statSync(hooksWritePath).mode
    mutateRealHomeHooksPreservingUserTrust({
      sourcePath: legacyConfigPath,
      runtimeHomePath: systemHomePath,
      tomlPath: getSystemCodexConfigTomlPath(),
      beforeHooks: config.hooks,
      afterHooks: nextHooks,
      writeHooks: () => {
        if (
          readFileSync(legacyConfigPath, 'utf-8') !== previousRaw ||
          resolveHooksJsonWritePath(legacyConfigPath) !== hooksWritePath
        ) {
          // Why: the pre-mutation RPC may overlap a user save; downgrade must
          // never replace that newer dotfiles generation with our stale parse.
          throw new Error('System Codex hooks changed during trust repair')
        }
        writeHooksJson(hooksWritePath, { ...config, hooks: nextHooks }, { preserveMode: true })
      },
      restoreHooks: () => writeFileAtomically(hooksWritePath, previousRaw, { mode: previousMode })
    })
    // Why: stale dev/version entries can reference an older managed script
    // path that is not represented by the current grant ledger.
    removeSelfComputedMatchingTrustEntries(getSystemCodexConfigTomlPath(), trustEntries)
  }
  if (removedManagedHook || hasRecordedRealHomeGrant) {
    // Why: the ledger recognizes Codex-computed hashes and remains a retry
    // marker if a prior cleanup removed hooks.json but could not update TOML.
    removeSystemManagedHookTrustEntries(systemHomePath, legacyConfigPath)
  }
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

function removeWslRuntimeManagedHookTrustEntries(plan: CodexWslRuntimeHookInstallPlan): void {
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

function removeStaleWslRuntimeManagedHookTrustEntries(
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
    const grant = grantManagedCodexHookTrust({
      runtimeHomePath,
      tomlPath: plan.tomlPath,
      managedCommand: command,
      managedEntries: trustEntries,
      host: { kind: 'wsl', distro: plan.wslDistro, linuxRuntimeHome: plan.linuxRuntimeHome },
      telemetryLane: 'managed'
    })
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
    // Why: JS is single-threaded, so the synchronous install below finishes
    // before any async `wsl.exe` settlement callback runs — this flag is
    // always set by the time the callback reads it.
    let installSucceeded = false
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
        resolvedTrustConfigPath: resolvedPlan?.trustConfigPath ?? null,
        installSucceeded
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
      installSucceeded = status.state === 'installed'
    }
    const wslPlan = createCodexWslRuntimeHookInstallPlan(
      runtimeHomePath,
      target,
      undefined,
      onCanonicalPathSettled
    )
    installedTrustConfigPath = wslPlan?.trustConfigPath ?? null
    const status = wslPlan ? installManagedHooksIntoWslRuntime(wslPlan) : null
    installSucceeded = status?.state === 'installed'
    return status
  }

  refreshRuntimeUserHooksForRuntimeHome(
    runtimeHomePath: string | null | undefined,
    target?: CodexWslRuntimeHookTarget
  ): AgentHookInstallStatus | null {
    this.supersedeWslReconciliation(runtimeHomePath)
    const wslPlan = createCodexWslRuntimeHookInstallPlan(runtimeHomePath, target)
    return wslPlan ? refreshWslRuntimeUserHooks(wslPlan) : null
  }

  getStatus(runtimeHomePath: string = getOrcaManagedCodexHomePath()): AgentHookInstallStatus {
    return this.getStatusAfterInstall(null, runtimeHomePath)
  }

  private getStatusAfterInstall(
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
      recentGrantEntries === null
        ? readCurrentCodexTrustGrantLedgerHome(runtimeHomePath, { kind: 'native' })
        : null
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

  // Why: runtimeHomePath defaults to the shared managed mirror, but a managed
  // account launching against its own self-contained CODEX_HOME passes that
  // per-account home so hooks.json/config.toml/trust land where codex reads.
  install(runtimeHomePath: string = getOrcaManagedCodexHomePath()): AgentHookInstallStatus {
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
    const mirroredTrustEntries: CodexTrustEntry[] = mirroredUserTrustEntries.map(
      ({ entry }) => entry
    )
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
      const grant = grantManagedCodexHookTrust({
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
    try {
      cleanupLegacySystemManagedHooks()
      cleanupLegacyCodexProfileHooks()
    } catch (error) {
      console.warn('[codex-hook-service] failed to clean legacy Codex hooks', error)
    }
    return this.getStatusAfterInstall(recentGrantEntries, runtimeHomePath)
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

  refreshRuntimeUserHooks(
    runtimeHomePath: string = getOrcaManagedCodexHomePath()
  ): AgentHookInstallStatus {
    const configPath = getConfigPath(runtimeHomePath)
    // Why: same as install() — capture in-Orca approvals before this refresh
    // rewrites the runtime files they are keyed against.
    promoteCodexRuntimeHookApprovalsToSystem(runtimeHomePath)
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
    const hookPlan = getRuntimeHooksWithSystemUserHooks(config.hooks, isManagedCommand, configPath)
    config.hooks = hookPlan.hooks
    writeCodexHooksJson(configPath, hookPlan.hooks)

    try {
      const tomlPath = getCodexConfigTomlPath(runtimeHomePath)
      const trustEntries = hookPlan.trustEntries.map(({ entry }) => entry)
      syncSystemConfigIntoManagedCodexHome({
        runtimeHomePath,
        systemHomePath: getSystemCodexHomePath()
      })
      // Why: this path is used when Orca status hooks are disabled. The
      // runtime CODEX_HOME should keep user hooks, but not Orca-managed trust.
      // Write current mirrored user trust first so stale cleanup compares
      // against current hashes while deleting old managed hook keys.
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
    snapshotCodexRuntimeHookTrustProvenance(runtimeHomePath)

    cleanupLegacyManagedHookRepresentations()
    return this.getStatus(runtimeHomePath)
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
