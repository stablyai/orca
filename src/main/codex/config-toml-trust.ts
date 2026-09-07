import { existsSync, readFileSync } from 'node:fs'
import {
  codexTrustSourcePathsEqual,
  computeCodexTrustedHash,
  computeCodexTrustKey,
  getExplicitHomeCodexHookSourcePath,
  normalizeCodexHookTrustLookupKey,
  normalizeCodexTrustProjectPath,
  normalizeCodexTrustProjectRevocationPath,
  normalizeCodexTrustSourcePath,
  parseCodexTrustKey
} from './codex-trust-identity'
import { writeTomlConfigAtomically } from './config-toml-atomic-write'
import { removeHookTrustContent, upsertHookTrustContent } from './config-toml-hook-trust-edit'
import { CodexHookTrustEntryMap, readHookTrustContent } from './config-toml-hook-trust-read'
import { upsertProjectTrustContent } from './config-toml-project-trust'
import { escapeTomlBasicString, parseProjectTomlHeaderPath } from './config-toml-syntax'
import { observe } from './codex-path-observation'

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

export type CodexTrustEntry = {
  /** Path on disk to the hooks.json that declares the hook (the "key_source"). */
  sourcePath: string
  /** Codex event label (snake_case). */
  eventLabel: CodexEventLabel
  /** 0-based index of the matcher group within the event array. */
  groupIndex: number
  /** 0-based index of the handler within the matcher group's `hooks` array. */
  handlerIndex: number
  /** The exact `command` string written to hooks.json. */
  command: string
  /** Effective timeout in seconds; defaults to 600 when undefined, explicit values clamped to a minimum of 1. */
  timeoutSec?: number
  /** Whether the handler is async. Defaults to false. */
  async?: boolean
  /** Optional matcher pattern (only meaningful for events that support it). */
  matcher?: string
  /** Optional statusMessage field. */
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

export function computeTrustedHash(entry: CodexTrustEntry): string {
  return computeCodexTrustedHash(entry)
}

export function computeTrustKey(entry: CodexTrustEntry): string {
  return computeCodexTrustKey(entry)
}

export function getCodexExplicitHomeHookSourcePath(sourcePath: string): string {
  return getExplicitHomeCodexHookSourcePath(sourcePath)
}

export function normalizeCodexHookSourcePath(sourcePath: string): string {
  return normalizeCodexTrustSourcePath(sourcePath)
}

export function normalizeCodexProjectPathForLookup(projectPath: string): string {
  return normalizeCodexTrustProjectPath(projectPath)
}

export function codexHookSourcePathsEqual(left: string, right: string): boolean {
  return codexTrustSourcePathsEqual(left, right)
}

export function normalizeCodexProjectPathForRevocationLookup(projectPath: string): string {
  return normalizeCodexTrustProjectRevocationPath(projectPath)
}

export function parseTrustKey(key: string): {
  sourcePath: string
  eventLabel: CodexEventLabel
  groupIndex: number
  handlerIndex: number
} | null {
  return parseCodexTrustKey(key)
}

// Why: trust edits preserve unrelated bytes instead of reserializing the user's config.
export function upsertHookTrustEntries(
  configPath: string,
  entries: readonly CodexTrustEntry[]
): void {
  const existing = readTomlForMutation(configPath)
  const updated = upsertHookTrustEntriesInContent(existing, entries)
  if (updated !== existing) {
    writeConfigAtomically(configPath, updated)
  }
}

export function upsertHookTrustEntriesInContent(
  existingContent: string,
  entries: readonly CodexTrustEntry[]
): string {
  return upsertHookTrustContent(existingContent, entries)
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

export function upsertProjectTrustLevelInContent(
  existingContent: string,
  projectPath: string,
  trustLevel: CodexProjectTrustLevel,
  options?: { alreadyCanonical?: boolean }
): string {
  return upsertProjectTrustContent(existingContent, projectPath, trustLevel, options)
}

export function escapeTomlString(value: string): string {
  return escapeTomlBasicString(value)
}

export function normalizeHookTrustKeyForLookup(key: string): string {
  return normalizeCodexHookTrustLookupKey(key)
}

export function parseCodexProjectHeaderPath(line: string): string | null {
  return parseProjectTomlHeaderPath(line)
}

export function writeConfigAtomically(configPath: string, contents: string): void {
  writeTomlConfigAtomically(configPath, contents)
}

export function removeHookTrustEntries(configPath: string, keys: readonly string[]): void {
  if (!existsSync(configPath)) {
    return
  }
  const existing = readTomlFile(configPath)
  const updated = removeHookTrustEntriesFromContent(existing, keys)
  if (updated !== existing) {
    writeConfigAtomically(configPath, updated)
  }
}

export function removeHookTrustEntriesFromContent(
  content: string,
  keys: readonly string[]
): string {
  return removeHookTrustContent(content, keys)
}

export function readHookTrustEntries(configPath: string): Map<string, CodexHookTrustState> {
  return existsSync(configPath)
    ? readHookTrustEntriesFromContent(readTomlFile(configPath))
    : new CodexHookTrustEntryMap()
}

export function readHookTrustEntriesFromContent(content: string): Map<string, CodexHookTrustState> {
  return readHookTrustContent(content)
}

function readTomlForMutation(configPath: string): string {
  // Why: only definitive absence may seed empty; an indeterminate read must preserve the existing file.
  const observation = observe(() => readTomlFile(configPath))
  if (observation.kind === 'indeterminate') {
    throw observation.error
  }
  return observation.kind === 'present' ? observation.value : ''
}

function readTomlFile(configPath: string): string {
  const raw = readFileSync(configPath, 'utf-8')
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
}
