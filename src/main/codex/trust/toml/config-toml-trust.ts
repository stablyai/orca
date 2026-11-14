import {
  readObservedFileSync as readFileSync,
  observedExistsSync as existsSync
} from '../../../filesystem/file-content-observation'

import { parse as parseToml } from 'smol-toml'
import { normalizeCodexTrustProjectPath } from '../identity/codex-trust-identity'
import { writeTomlConfigAtomically as writeConfigAtomically } from '../../configuration/toml/config-toml-atomic-write'
import { findAllHookTrustBlocks } from './config-toml-hook-trust-blocks'
import {
  getTrustKeyWriteVariants,
  moveHookTrustContent,
  readHookTrustBlockTexts,
  restoreHookTrustBlockContent,
  upsertHookTrustContent as upsertHookTrustEntriesInContent,
  removeHookTrustContent as removeHookTrustEntriesFromContent
} from './config-toml-hook-trust-edit'
import {
  CodexHookTrustEntryMap,
  readHookTrustContent as readHookTrustEntriesFromContent
} from './config-toml-hook-trust-read'
import {
  findProjectTrustRemovedBytes,
  hasProjectTrustEntry,
  removeProjectTrustContent,
  upsertProjectTrustContent as upsertProjectTrustLevelInContent
} from './config-toml-project-trust'
import { createAgentTrustOwnershipLedger } from '../../../agent-launch/trust/agent-trust-ownership-ledger'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import { observe } from '../../configuration/codex-path-observation'
import '../../configuration/toml/config-toml-syntax'

export type CodexEventLabel =
  | 'pre_tool_use'
  | 'permission_request'
  | 'post_tool_use'
  | 'pre_compact'
  | 'post_compact'
  | 'session_start'
  | 'user_prompt_submit'
  | 'subagent_start'
  | 'subagent_stop'
  | 'stop'
  | 'interrupt'

export type CodexTrustEntry = {
  /** Path on disk to the hooks.json that declares the hook (the "key_source"). */
  sourcePath: string
  eventLabel: CodexEventLabel
  /** 0-based index of the matcher group within the event array. */
  groupIndex: number
  /** 0-based index of the handler within the matcher group's `hooks` array. */
  handlerIndex: number
  /** The exact `command` string written to hooks.json. */
  command: string
  /** Seconds: Interrupt defaults to 1 and clamps to 1–3; other events default to 600, minimum 1. */
  timeoutSec?: number
  /** Whether the handler is async. Defaults to false. */
  async?: boolean
  /** Optional matcher pattern (only meaningful for events that support it). */
  matcher?: string
  statusMessage?: string
  /** Verbatim hash to write instead of computing one. Never fed into hashing. */
  trustedHash?: string
  /** Explicit enabled state to write; when absent, a pre-existing `enabled = false` is preserved. */
  enabled?: boolean
}

export type CodexHookTrustState = {
  trustedHash?: string
  enabled?: boolean
}

export type CodexProjectTrustLevel = 'trusted' | 'untrusted'

/** Preserve unrelated config bytes and refuse edits that would break previously loadable TOML. */
export function upsertHookTrustEntries(
  configPath: string,
  entries: readonly CodexTrustEntry[]
): void {
  const existing = readTomlForMutation(configPath)
  const updated = upsertHookTrustEntriesInContent(existing, entries)
  if (updated !== existing) {
    writeLoadableHookTrustConfig(configPath, existing, updated)
  }
}

export class CodexConfigTomlRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexConfigTomlRefusedError'
  }
}

export function isCodexConfigTomlRefusedError(
  error: unknown
): error is CodexConfigTomlRefusedError {
  return error instanceof Error && error.name === 'CodexConfigTomlRefusedError'
}

/** Inline or dotted approvals can conflict with appended tables; reject newly invalid TOML. */
export function writeLoadableHookTrustConfig(
  configPath: string,
  previous: string,
  contents: string
): void {
  assertLoadableHookTrustConfig(configPath, previous, contents)
  writeConfigAtomically(configPath, contents)
}

export function assertLoadableHookTrustConfig(
  configPath: string,
  previous: string,
  contents: string
): void {
  if (isLoadableToml(previous) && !isLoadableToml(contents)) {
    throw new CodexConfigTomlRefusedError(
      `${configPath} defines hook approvals in a form Orca cannot add to without breaking it`
    )
  }
}

export function readHookTrustBlocks(
  configPath: string,
  keys: readonly string[]
): Map<string, string[]> {
  const content = existsSync(configPath) ? readTomlFile(configPath) : ''
  return new Map(keys.map((key) => [key, readHookTrustBlockTexts(content, key)]))
}

export function restoreHookTrustBlocks(
  configPath: string,
  restores: readonly { key: string; blocks: readonly string[] }[]
): void {
  if (restores.length === 0 || !existsSync(configPath)) {
    return
  }
  const existing = readTomlFile(configPath)
  const updated = restoreHookTrustBlockContent(existing, restores)
  if (updated !== existing) {
    writeLoadableHookTrustConfig(configPath, existing, updated)
  }
}

function isLoadableToml(content: string): boolean {
  try {
    parseToml(stripLeadingBom(content))
    return true
  } catch {
    return false
  }
}

export function moveHookTrustEntries(
  configPath: string,
  moves: readonly { oldKey: string; newKey: string }[]
): void {
  if (moves.length === 0 || !existsSync(configPath)) {
    return
  }
  const existing = readTomlForMutation(configPath)
  const updated = moveHookTrustContent(existing, moves)
  if (updated !== existing) {
    writeLoadableHookTrustConfig(configPath, existing, updated)
  }
}

export function upsertProjectTrustLevel(
  configPath: string,
  projectPath: string,
  trustLevel: CodexProjectTrustLevel
): void {
  const existing = readTomlForMutation(configPath)
  const updated = upsertProjectTrustLevelInContent(existing, projectPath, trustLevel)
  if (updated !== existing) {
    writeConfigAtomically(configPath, updated)
  }
}

/**
 * Grants project trust and records the tables this grant created, so a removed
 * worktree's entry can be deleted later without touching a table that existed
 * at the path before Orca first wrote it.
 */
const codexProjectTrustOwnership = createAgentTrustOwnershipLedger(
  'codex-project-trust-created.json',
  normalizeCodexTrustProjectPath
)

export function upsertOrcaCreatedProjectTrustLevel(
  configPath: string,
  projectPath: string,
  trustLevel: CodexProjectTrustLevel
): void {
  const existing = readTomlForMutation(configPath)
  const created = !hasProjectTrustEntry(existing, projectPath)
  const updated = upsertProjectTrustLevelInContent(existing, projectPath, trustLevel)
  if (updated !== existing) {
    writeConfigAtomically(configPath, updated)
  }
  if (!created) {
    return
  }
  try {
    codexProjectTrustOwnership.record(
      configPath,
      projectPath,
      findProjectTrustRemovedBytes(updated, projectPath) ?? ''
    )
  } catch (error) {
    // Why: the grant already landed; an unrecorded entry only loses cleanup, never safety.
    console.warn('[codex-config] Failed to record the created project trust entry:', error)
  }
}

/**
 * Removes every Orca-created project trust entry for `projectPath`, wherever
 * recorded. Never throws: removal rides the worktree-removal path, which must
 * not fail over a config file it cannot read — the record is kept so a later
 * pass retries. Resolves once every touched file has been written.
 */
export async function removeOrcaCreatedProjectTrustEntries(projectPath: string): Promise<void> {
  for (const configPath of codexProjectTrustOwnership.listConfigFiles(projectPath)) {
    await runExclusivelyForCodexTrustConfig(configPath, async () => {
      try {
        removeOrcaCreatedProjectTrustEntry(configPath, projectPath)
      } catch (error) {
        console.warn('[codex-config] Failed to remove an Orca-created project trust entry:', error)
      }
    })
  }
}

// Why: the separator below a table belongs to what follows it, not to the table Orca wrote.
function withoutTrailingSeparator(bytes: string): string {
  return bytes.replace(/[\r\n]+$/, '')
}

function removeOrcaCreatedProjectTrustEntry(configPath: string, projectPath: string): void {
  // Why: same lane as the grant writers (#16441), so a queued writer cannot rewrite the entry back.
  const observation = observe(() => readTomlFile(configPath))
  if (observation.kind === 'indeterminate') {
    return
  }
  if (observation.kind === 'absent') {
    codexProjectTrustOwnership.forget(configPath, projectPath)
    return
  }
  const ownedTable = codexProjectTrustOwnership.getWritten(configPath, projectPath)
  const currentTable = findProjectTrustRemovedBytes(observation.value, projectPath)
  if (
    ownedTable === null ||
    currentTable === null ||
    withoutTrailingSeparator(currentTable) !== withoutTrailingSeparator(ownedTable)
  ) {
    // Why: the bytes at the path are no longer what Orca wrote, so the record no longer vouches
    // for the table — dropping it keeps a later pass from deleting someone else's replacement.
    codexProjectTrustOwnership.forget(configPath, projectPath)
    return
  }
  const updated = removeProjectTrustContent(observation.value, projectPath)
  if (updated !== observation.value) {
    writeConfigAtomically(configPath, updated)
  }
  codexProjectTrustOwnership.forget(configPath, projectPath)
}

export function removeHookTrustEntries(configPath: string, keys: readonly string[]): void {
  if (!existsSync(configPath)) {
    return
  }
  const existing = readTomlFile(configPath)
  const updated = removeHookTrustEntriesFromContent(existing, keys)
  if (updated !== existing) {
    writeLoadableHookTrustConfig(configPath, existing, updated)
  }
}

export function readHookTrustEntries(configPath: string): Map<string, CodexHookTrustState> {
  return existsSync(configPath)
    ? readHookTrustEntriesFromContent(readTomlFile(configPath))
    : new CodexHookTrustEntryMap()
}

/** Check exact spellings: separator-folded lookups could hide a missing Windows approval table. */
export function readHookTrustKeySpellings(configPath: string): (key: string) => boolean {
  const written = new Set(
    existsSync(configPath)
      ? findAllHookTrustBlocks(readTomlFile(configPath)).map(({ key }) => key)
      : []
  )
  return (key) => getTrustKeyWriteVariants(key).every((spelling) => written.has(spelling))
}

function readTomlForMutation(configPath: string): string {
  // Only confirmed absence permits seeding an empty config.
  const observation = observe(() => readTomlFile(configPath))
  if (observation.kind === 'indeterminate') {
    throw observation.error
  }
  return observation.kind === 'present' ? observation.value : ''
}

function readTomlFile(configPath: string): string {
  return stripLeadingBom(readFileSync(configPath, 'utf-8'))
}

function stripLeadingBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}
