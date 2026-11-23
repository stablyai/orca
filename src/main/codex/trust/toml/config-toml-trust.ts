import {
  readObservedFileSync as readFileSync,
  observedExistsSync as existsSync
} from '../../../filesystem/file-content-observation'

import { parse as parseToml } from 'smol-toml'
import { writeTomlConfigAtomically } from '../../configuration/toml/config-toml-atomic-write'
import { ConcurrentFileEditError } from '../../../filesystem/concurrent-file-edit-guard'
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
import { upsertProjectTrustContent as upsertProjectTrustLevelInContent } from './config-toml-project-trust'
import { observe } from '../../configuration/codex-path-observation'
import '../../configuration/toml/config-toml-syntax'

export type CodexEventLabel =
  | 'pre_tool_use'
  | 'permission_request'
  | 'post_tool_use'
  | 'pre_compact'
  | 'post_compact'
  | 'session_start'
  | 'session_end'
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
  editLoadableHookTrustConfig(configPath, 'seed', (existing) =>
    upsertHookTrustEntriesInContent(existing, entries)
  )
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

const PUBLISH_ATTEMPTS = 3

/**
 * Applies `edit` to the config's BOM-free content and publishes it only while the file still holds
 * the bytes it was made from; a save that lands in between is kept and the edit is redone on it.
 * `missing: 'skip'` leaves an absent config absent; `'seed'` edits it as empty.
 */
function editTomlConfig(
  configPath: string,
  missing: 'skip' | 'seed',
  edit: (existing: string) => string
): void {
  if (missing === 'skip' && !existsSync(configPath)) {
    return
  }
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
    // Only confirmed absence permits seeding an empty config.
    const raw = observeRawTomlForMutation(configPath)
    if (raw === null && missing === 'skip') {
      return
    }
    const existing = stripLeadingBom(raw ?? '')
    const updated = edit(existing)
    if (updated === existing || writeTomlConfigAtomically(configPath, updated, raw)) {
      return
    }
  }
  throw new ConcurrentFileEditError(configPath)
}

/** Inline or dotted approvals can conflict with appended tables; reject newly invalid TOML. */
export function editLoadableHookTrustConfig(
  configPath: string,
  missing: 'skip' | 'seed',
  edit: (existing: string) => string
): void {
  editTomlConfig(configPath, missing, (existing) => {
    const updated = edit(existing)
    if (updated !== existing) {
      assertLoadableHookTrustConfig(configPath, existing, updated)
    }
    return updated
  })
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
  if (restores.length === 0) {
    return
  }
  editLoadableHookTrustConfig(configPath, 'skip', (existing) =>
    restoreHookTrustBlockContent(existing, restores)
  )
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
  if (moves.length === 0) {
    return
  }
  editLoadableHookTrustConfig(configPath, 'skip', (existing) =>
    moveHookTrustContent(existing, moves)
  )
}

export function upsertProjectTrustLevel(
  configPath: string,
  projectPath: string,
  trustLevel: CodexProjectTrustLevel
): void {
  editTomlConfig(configPath, 'seed', (existing) =>
    upsertProjectTrustLevelInContent(existing, projectPath, trustLevel)
  )
}

export function removeHookTrustEntries(configPath: string, keys: readonly string[]): void {
  editLoadableHookTrustConfig(configPath, 'skip', (existing) =>
    removeHookTrustEntriesFromContent(existing, keys)
  )
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

function observeRawTomlForMutation(configPath: string): string | null {
  const observation = observe(() => readFileSync(configPath, 'utf-8'))
  if (observation.kind === 'indeterminate') {
    throw observation.error
  }
  return observation.kind === 'present' ? observation.value : null
}

function readTomlFile(configPath: string): string {
  return stripLeadingBom(readFileSync(configPath, 'utf-8'))
}

export function stripLeadingBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}
