/* eslint-disable max-lines -- Why: Codex hook trust parsing, hashing, and byte-preserving TOML edits share one fragile file-format contract; splitting would make the compatibility shim harder to audit. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileWithWindowsRetry, renameFileWithWindowsRetry } from '../codex-accounts/fs-utils'
import {
  createTomlLineScanState,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'

// Why: Codex 0.129+ gates each hook on a `trusted_hash` entry in
// ~/.codex/config.toml under [hooks.state."<key>"]. Without it the hook is in
// the "review required" pile and never fires, so the agent-status sidebar
// silently goes blank. We reproduce Codex's hash so install() can register
// trust the same way `/hooks` would. Algorithm reverse-engineered from
// codex-rs/hooks/src/engine/discovery.rs (command_hook_hash) +
// codex-rs/config/src/fingerprint.rs (version_for_toml).

export type CodexEventLabel =
  | 'pre_tool_use'
  | 'permission_request'
  | 'post_tool_use'
  | 'pre_compact'
  | 'post_compact'
  | 'session_start'
  | 'user_prompt_submit'
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
  /** Effective timeout in seconds. When undefined, defaults to 600.
   *  Explicit values are clamped to a minimum of 1. */
  timeoutSec?: number
  /** Whether the handler is async. Defaults to false. */
  async?: boolean
  /** Optional matcher pattern (only meaningful for events that support it). */
  matcher?: string
  /** Optional statusMessage field. */
  statusMessage?: string
  /** Verbatim hash to write instead of computing one. Used when carrying a
   *  Codex-written approval across files, so trust survives even if Codex's
   *  hash algorithm drifts from computeTrustedHash. Never fed into hashing. */
  trustedHash?: string
  /** Explicit enabled state to write. When absent, a pre-existing
   *  `enabled = false` on the target block is preserved. */
  enabled?: boolean
}

export type CodexHookTrustState = {
  trustedHash?: string
  enabled?: boolean
}

export type CodexProjectTrustLevel = 'trusted' | 'untrusted'

// Why: callers use computeTrustKey() for lookups, while existing TOML can carry
// Codex-written separator/casing variants. Normalize both sides at the Map edge.
class HookTrustEntryMap extends Map<string, CodexHookTrustState> {
  override get(key: string): CodexHookTrustState | undefined {
    return super.get(normalizeHookTrustKeyForLookup(key))
  }

  override has(key: string): boolean {
    return super.has(normalizeHookTrustKeyForLookup(key))
  }

  override delete(key: string): boolean {
    return super.delete(normalizeHookTrustKeyForLookup(key))
  }

  override set(key: string, value: CodexHookTrustState): this {
    return super.set(normalizeHookTrustKeyForLookup(key), value)
  }
}

// Why: matches Codex's canonical_json. Sorts object keys recursively before
// SHA-256ing; arrays preserve order.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

// Why: reproduces matcher_pattern_for_event (codex-rs
// hooks/src/events/common.rs). Codex ignores matchers on
// UserPromptSubmit/Stop and drops them from the hook identity BEFORE
// hashing, so a hooks.json entry carrying `"matcher": ""` on those
// events must hash the same as one without it. Including it computes a
// hash Codex never writes: system trust then looks stale, and
// removeStaleRuntimeHookTrustEntries deletes the entry Codex wrote on
// every launch — an endless re-trust prompt for those two events.
function matcherPatternForEvent(
  eventLabel: CodexEventLabel,
  matcher: string | undefined
): string | undefined {
  switch (eventLabel) {
    case 'user_prompt_submit':
    case 'stop':
      return undefined
    case 'pre_tool_use':
    case 'permission_request':
    case 'post_tool_use':
    case 'pre_compact':
    case 'post_compact':
    case 'session_start':
      return matcher
  }
}

// Why: reproduces command_hook_hash. NormalizedHookIdentity has `group:
// MatcherGroup` flattened in, so the wire shape is { event_name, matcher?,
// hooks: [<normalized handler>] }. `matcher` is omitted (not null) when
// absent — Rust's Option<String>=None drops through the TOML→JSON path —
// and normalized per event first (see matcherPatternForEvent).
// Handler is normalized to timeout=600 (or explicit, min 1) and async=false.
export function computeTrustedHash(entry: CodexTrustEntry): string {
  const handler: Record<string, unknown> = {
    type: 'command',
    command: entry.command,
    timeout: Math.max(1, entry.timeoutSec ?? 600),
    async: entry.async ?? false
  }
  if (entry.statusMessage !== undefined) {
    handler.statusMessage = entry.statusMessage
  }
  const identity: Record<string, unknown> = {
    event_name: entry.eventLabel,
    hooks: [handler]
  }
  const matcher = matcherPatternForEvent(entry.eventLabel, entry.matcher)
  if (matcher !== undefined) {
    identity.matcher = matcher
  }
  const serialized = JSON.stringify(canonicalize(identity))
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`
}

export function computeTrustKey(entry: CodexTrustEntry): string {
  return `${getCodexCanonicalTrustPath(entry.sourcePath)}:${entry.eventLabel}:${entry.groupIndex}:${entry.handlerIndex}`
}

export function getCodexCanonicalTrustPath(sourcePath: string): string {
  try {
    // Why: Codex canonicalizes trust paths before building config keys. On
    // macOS, /var is a symlink to /private/var; trusting the raw path still
    // leaves the TUI in review/trust prompts. On Windows, Codex 0.140 writes
    // hook state keys with native raw backslashes under an explicit parent table.
    return realpathSync.native(sourcePath)
  } catch {
    return normalizeWindowsPathForCodexLookup(sourcePath)
  }
}

function getCodexCanonicalProjectPath(projectPath: string): string {
  try {
    // Why: local project trust still needs Codex's realpath shape, but remote
    // SSH callers pass an already-canonical remote path string.
    return realpathSync.native(projectPath)
  } catch {
    return projectPath
  }
}

function normalizeWindowsPathForCodexLookup(sourcePath: string): string {
  if (!usesWindowsPathSeparators(sourcePath)) {
    return sourcePath
  }
  return sourcePath.replace(/\//g, '\\')
}

function normalizeWindowsPathSeparators(sourcePath: string): string {
  if (!usesWindowsPathSeparators(sourcePath)) {
    return sourcePath
  }
  return sourcePath.replace(/\\/g, '/')
}

function usesWindowsPathSeparators(sourcePath: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(sourcePath) ||
    sourcePath.startsWith('\\\\') ||
    sourcePath.startsWith('//')
  )
}

// Why: Codex and Orca can disagree on quote style, separators, and casing for
// the same Windows project, including when the caller targets a remote host.
export function normalizeCodexProjectPathForLookup(projectPath: string): string {
  return usesWindowsPathSeparators(projectPath)
    ? normalizeWindowsPathSeparators(projectPath).toLowerCase()
    : projectPath
}

export function parseTrustKey(key: string): {
  sourcePath: string
  eventLabel: CodexEventLabel
  groupIndex: number
  handlerIndex: number
} | null {
  // Why: keys have shape `<sourcePath>:<eventLabel>:<groupIdx>:<handlerIdx>`.
  // sourcePath itself may contain `:` (Windows drive letters), so anchor the
  // parse at the LAST three colons rather than the first.
  const lastColon = key.lastIndexOf(':')
  if (lastColon === -1) {
    return null
  }
  const handlerStr = key.slice(lastColon + 1)
  if (!isCanonicalNonNegativeInt(handlerStr)) {
    return null
  }
  const secondLast = key.lastIndexOf(':', lastColon - 1)
  if (secondLast === -1) {
    return null
  }
  const groupStr = key.slice(secondLast + 1, lastColon)
  if (!isCanonicalNonNegativeInt(groupStr)) {
    return null
  }
  const thirdLast = key.lastIndexOf(':', secondLast - 1)
  if (thirdLast === -1) {
    return null
  }
  const eventLabel = key.slice(thirdLast + 1, secondLast)
  if (!isCodexEventLabel(eventLabel)) {
    return null
  }
  const sourcePath = key.slice(0, thirdLast)
  if (sourcePath.length === 0) {
    return null
  }
  return {
    sourcePath,
    eventLabel,
    groupIndex: Number(groupStr),
    handlerIndex: Number(handlerStr)
  }
}

// Why: Number('') === 0 and Number('1e2') === 100 both pass Number.isInteger,
// so reject any non-canonical decimal form before numeric conversion.
function isCanonicalNonNegativeInt(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value)
}

function isCodexEventLabel(value: string): value is CodexEventLabel {
  return (
    value === 'pre_tool_use' ||
    value === 'permission_request' ||
    value === 'post_tool_use' ||
    value === 'pre_compact' ||
    value === 'post_compact' ||
    value === 'session_start' ||
    value === 'user_prompt_submit' ||
    value === 'stop'
  )
}

// Why: TOML 1.0 forbids BOMs but real-world editors (especially on Windows) sometimes
// write them. A leading ﻿ would break header regexes anchored at `^[ \t]*\[`, so
// strip it once at the file boundary and let the rest of the parser stay simple.
function readTomlFile(configPath: string): string {
  const raw = readFileSync(configPath, 'utf-8')
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
}

// Why: regex-edit ~/.codex/config.toml rather than parse + reserialize. The
// file is hand-edited by users (and other tools) and a round-trip through
// any TOML library would lose comments, key ordering, and inline-table
// style. We only ever (a) replace an existing [hooks.state."<key>"] block
// keyed by *our* known hook keys, or (b) append a new block at EOF. Other
// content is byte-preserved.
// Why: this is a read-modify-write with no inter-process lock. Codex CLI's
// /hooks flow also writes [hooks.state.*] blocks in this file, so two
// concurrent writers can lose each other's edits. writeConfigAtomically
// prevents partial writes but not lost updates. install() is idempotent
// (deterministic hashes), so the next install() repairs drift.
export function upsertHookTrustEntries(
  configPath: string,
  entries: readonly CodexTrustEntry[]
): void {
  const existing = existsSync(configPath) ? readTomlFile(configPath) : ''
  const updated = upsertHookTrustEntriesInContent(existing, entries)
  if (updated === existing) {
    return
  }
  writeConfigAtomically(configPath, updated)
}

export function upsertHookTrustEntriesInContent(
  existingContent: string,
  entries: readonly CodexTrustEntry[]
): string {
  const existing =
    existingContent.charCodeAt(0) === 0xfeff ? existingContent.slice(1) : existingContent
  let updated = entries.some((entry) =>
    usesWindowsPathSeparators(getCodexCanonicalTrustPath(entry.sourcePath))
  )
    ? ensureHooksStateParentTable(existing)
    : existing
  for (const entry of entries) {
    updated = upsertTrustBlocks(
      updated,
      getTrustKeyWriteVariants(computeTrustKey(entry)),
      entry.trustedHash ?? computeTrustedHash(entry),
      entry.enabled
    )
  }
  return updated
}

export function upsertProjectTrustLevel(
  configPath: string,
  projectPath: string,
  trustLevel: CodexProjectTrustLevel
): void {
  const existing = existsSync(configPath) ? readTomlFile(configPath) : ''
  const updated = upsertProjectTrustLevelInContent(existing, projectPath, trustLevel)
  if (updated === existing) {
    return
  }
  writeConfigAtomically(configPath, updated)
}

export function upsertProjectTrustLevelInContent(
  existingContent: string,
  projectPath: string,
  trustLevel: CodexProjectTrustLevel,
  options?: { alreadyCanonical?: boolean }
): string {
  const existing =
    existingContent.charCodeAt(0) === 0xfeff ? existingContent.slice(1) : existingContent
  const trustedProjectPath = options?.alreadyCanonical
    ? projectPath
    : getCodexCanonicalProjectPath(projectPath)
  const headerLineEnd = findProjectHeaderLineEnd(existing, trustedProjectPath)
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const trustLine = `trust_level = "${trustLevel}"`

  if (headerLineEnd === null) {
    const block = [`[projects."${escapeTomlString(trustedProjectPath)}"]`, trustLine].join(eol)
    if (existing.length === 0) {
      return `${block}${eol}`
    }
    const separator = existing.endsWith(`${eol}${eol}`)
      ? ''
      : existing.endsWith(eol)
        ? eol
        : eol + eol
    return `${existing}${separator}${block}${eol}`
  }

  const after = existing.slice(headerLineEnd)
  const nextHeaderRel = findNextTableHeader(after)
  const blockEnd = nextHeaderRel === -1 ? existing.length : headerLineEnd + nextHeaderRel
  const existingBlock = existing.slice(headerLineEnd, blockEnd)
  const trustLevelLinePattern =
    /^[ \t]*trust_level[ \t]*=[ \t]*(?:"(?:trusted|untrusted)"|'(?:trusted|untrusted)')[ \t\r]*(?:#.*)?$/m
  if (trustLevelLinePattern.test(existingBlock)) {
    return (
      existing.slice(0, headerLineEnd) +
      existingBlock.replace(trustLevelLinePattern, trustLine) +
      existing.slice(blockEnd)
    )
  }
  return `${existing.slice(0, headerLineEnd)}${eol}${trustLine}${existing.slice(headerLineEnd)}`
}

// Why: build the canonical block we own. The two field names mirror what
// Codex itself writes when the user approves via /hooks (HookStateToml
// fields). `enabled` is plumbed through so an existing user-set
// `enabled = false` survives reinstall.
function buildTrustBlock(key: string, hash: string, enabled: boolean): string {
  return [
    `[hooks.state.${formatHookStateTableKey(key)}]`,
    `enabled = ${enabled}`,
    `trusted_hash = "${escapeTomlString(hash)}"`
  ].join('\n')
}

function formatHookStateTableKey(key: string): string {
  const parsed = parseTrustKey(key)
  if (parsed && usesWindowsPathSeparators(parsed.sourcePath) && !key.includes("'")) {
    // Why: Codex 0.140 trusts Windows hooks only when the state table keys
    // match the raw native path shape it writes after /hooks approval.
    return `'${key}'`
  }
  return `"${escapeTomlString(key)}"`
}

function getTrustKeyWriteVariants(key: string): string[] {
  const parsed = parseTrustKey(key)
  if (!parsed || !usesWindowsPathSeparators(parsed.sourcePath)) {
    return [key]
  }
  const suffix = `:${parsed.eventLabel}:${parsed.groupIndex}:${parsed.handlerIndex}`
  return [
    `${parsed.sourcePath.replace(/\//g, '\\')}${suffix}`,
    `${parsed.sourcePath.replace(/\\/g, '/')}${suffix}`
  ].filter((variant, index, variants) => variants.indexOf(variant) === index)
}

// Why: TOML basic strings forbid raw control chars; escape backslash first so
// later substitutions don't double-escape the inserted backslashes.
export function escapeTomlString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\b', '\\b')
    .replaceAll('\f', '\\f')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
}

function upsertTrustBlocks(
  content: string,
  keys: readonly string[],
  hash: string,
  explicitEnabled?: boolean
): string {
  const ranges = keys
    .flatMap((key) => findTrustBlockRanges(content, key))
    .filter(
      (range, index, ranges) =>
        ranges.findIndex(
          (candidate) => candidate.start === range.start && candidate.end === range.end
        ) === index
    )
    .sort((a, b) => a.start - b.start)
  if (ranges.length === 0) {
    const block = buildTrustBlocks(keys, hash, explicitEnabled ?? true)
    if (content.length === 0) {
      return `${block}\n`
    }
    // Why: leave one blank line before our appended block so the file stays
    // readable, but don't compound separators when the file already ends in
    // a blank line.
    const separator = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n'
    return `${content}${separator}${block}\n`
  }

  // Why: preserve a user-set `enabled = false` so a hand-disabled hook is not
  // silently re-enabled by the next auto-install on app start.
  // If duplicate blocks already exist, treat any disabled copy as authoritative
  // while collapsing the malformed TOML back to one table.
  // An explicit enabled state (write-back promotion of an in-Orca /hooks
  // toggle) overrides that preservation: it IS the user's latest decision.
  const enabled =
    explicitEnabled ??
    !ranges.some((range) => {
      const existingBlock = content.slice(range.headerLineEnd, range.end)
      const enabledMatch = /^[ \t]*enabled[ \t]*=[ \t]*(true|false)[ \t\r]*(?:#.*)?$/m.exec(
        existingBlock
      )
      return enabledMatch?.[1] === 'false'
    })
  const block = buildTrustBlocks(keys, hash, enabled)
  let cursor = 0
  let deduped = ''
  ranges.forEach((range, index) => {
    deduped += content.slice(cursor, range.start)
    if (index === 0) {
      deduped += `${block}\n`
    }
    cursor = range.end
  })
  return deduped + content.slice(cursor)
}

function buildTrustBlocks(keys: readonly string[], hash: string, enabled: boolean): string {
  // Why: Codex 0.140 can expose Windows hook-state keys with either native
  // backslashes or forward slashes depending on the cwd string used at startup.
  return keys.map((key) => buildTrustBlock(key, hash, enabled)).join('\n\n')
}

function ensureHooksStateParentTable(content: string): string {
  if (/^[ \t]*\[hooks\.state\][ \t]*(?:#[^\r\n]*)?$/m.test(content)) {
    return content
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const parent = `[hooks.state]${eol}`
  const hookHeader = /^[ \t]*\[hooks\.state\.(?:"|')/m.exec(content)
  if (hookHeader) {
    return `${content.slice(0, hookHeader.index)}${parent}${eol}${content.slice(hookHeader.index)}`
  }
  if (content.length === 0) {
    return parent
  }
  const separator = content.endsWith(`${eol}${eol}`) ? '' : content.endsWith(eol) ? eol : eol + eol
  return `${content}${separator}${parent}`
}

type TrustBlockRange = {
  start: number
  headerLineEnd: number
  end: number
}

// Why: separator and casing drift between Codex-written keys (raw backslash,
// potentially lowercased) and Orca-built keys (forward-slash, realpathSync.native
// casing) must not prevent findTrustBlockRanges from matching an existing block.
export function normalizeHookTrustKeyForLookup(key: string): string {
  const parsed = parseTrustKey(key)
  const separated = parsed
    ? `${normalizeWindowsPathSeparators(parsed.sourcePath)}:${parsed.eventLabel}:${parsed.groupIndex}:${parsed.handlerIndex}`
    : normalizeWindowsPathSeparators(key)
  // Why: Windows-native paths are case-insensitive, but WSL and SSH trust
  // sources remain case-sensitive even when Orca's host process is Windows.
  const caseInsensitiveWindowsPath =
    process.platform === 'win32' && usesWindowsPathSeparators(parsed?.sourcePath ?? key)
  return caseInsensitiveWindowsPath ? separated.toLowerCase() : separated
}

function findTrustBlockRanges(content: string, key: string): TrustBlockRange[] {
  const ranges: TrustBlockRange[] = []
  let cursor = 0
  let scanState = createTomlLineScanState()
  while (cursor < content.length) {
    const newlineIdx = content.indexOf('\n', cursor)
    const lineEnd = newlineIdx === -1 ? content.length : newlineIdx
    const rawLine = content.slice(cursor, lineEnd)
    const line = rawLine.replace(/\r$/, '')
    const nextCursor = newlineIdx === -1 ? content.length : newlineIdx + 1
    const headerKey = isTomlStructuralLine(scanState) ? parseHookStateHeaderKey(line) : null
    if (
      headerKey !== null &&
      normalizeHookTrustKeyForLookup(headerKey) === normalizeHookTrustKeyForLookup(key)
    ) {
      const headerLineEnd = rawLine.endsWith('\r') ? lineEnd - 1 : lineEnd
      const after = content.slice(headerLineEnd)
      const nextHeaderRel = findNextTableHeader(after)
      const blockEnd = nextHeaderRel === -1 ? content.length : headerLineEnd + nextHeaderRel
      ranges.push({ start: cursor, headerLineEnd, end: blockEnd })
      cursor = Math.max(blockEnd, nextCursor)
      continue
    }
    scanState = updateTomlLineScanState(scanState, line)
    cursor = nextCursor
  }
  return ranges
}

type ParsedTomlString = {
  value: string
  endIndex: number
}

// Why: Codex can write hook-state dotted keys as TOML basic strings while
// users/Codex TUI may leave equivalent literal-string keys behind.
function parseHookStateHeaderKey(line: string): string | null {
  const trimmed = line.trimStart()
  const prefixMatch = /^\[[ \t]*hooks[ \t]*\.[ \t]*state[ \t]*\.[ \t]*/.exec(trimmed)
  if (!prefixMatch) {
    return null
  }
  const parsedKey = parseTomlSingleLineString(trimmed, prefixMatch[0].length)
  if (!parsedKey) {
    return null
  }
  let index = skipTomlInlineWhitespace(trimmed, parsedKey.endIndex)
  if (trimmed[index] !== ']') {
    return null
  }
  index = skipTomlInlineWhitespace(trimmed, index + 1)
  return index === trimmed.length || trimmed[index] === '#' ? parsedKey.value : null
}

export function parseCodexProjectHeaderPath(line: string): string | null {
  // Why: mirror section headers come from split CRLF files and retain the
  // terminal carriage return, while direct upserts scan CR-stripped lines.
  const trimmed = line.replace(/\r$/, '').trimStart()
  const prefixMatch = /^\[[ \t]*projects[ \t]*\.[ \t]*/.exec(trimmed)
  if (!prefixMatch) {
    return null
  }
  const parsedPath = parseTomlSingleLineString(trimmed, prefixMatch[0].length)
  if (!parsedPath) {
    return null
  }
  let index = skipTomlInlineWhitespace(trimmed, parsedPath.endIndex)
  if (trimmed[index] !== ']') {
    return null
  }
  index = skipTomlInlineWhitespace(trimmed, index + 1)
  return index === trimmed.length || trimmed[index] === '#' ? parsedPath.value : null
}

function findProjectHeaderLineEnd(content: string, projectPath: string): number | null {
  const lookupPath = normalizeCodexProjectPathForLookup(projectPath)
  let cursor = 0
  let scanState = createTomlLineScanState()
  while (cursor < content.length) {
    const newlineIndex = content.indexOf('\n', cursor)
    const lineEnd = newlineIndex === -1 ? content.length : newlineIndex
    const rawLine = content.slice(cursor, lineEnd)
    const line = rawLine.replace(/\r$/, '')
    const existingPath = isTomlStructuralLine(scanState) ? parseCodexProjectHeaderPath(line) : null
    if (existingPath !== null && normalizeCodexProjectPathForLookup(existingPath) === lookupPath) {
      return rawLine.endsWith('\r') ? lineEnd - 1 : lineEnd
    }
    scanState = updateTomlLineScanState(scanState, line)
    if (newlineIndex === -1) {
      return null
    }
    cursor = newlineIndex + 1
  }
  return null
}

function parseTomlSingleLineString(line: string, startIndex: number): ParsedTomlString | null {
  if (line[startIndex] === '"') {
    return parseTomlBasicSingleLineString(line, startIndex + 1)
  }
  if (line[startIndex] === "'") {
    return parseTomlLiteralSingleLineString(line, startIndex + 1)
  }
  return null
}

function parseTomlBasicSingleLineString(line: string, startIndex: number): ParsedTomlString | null {
  let value = ''
  let index = startIndex
  while (index < line.length) {
    const char = line[index]
    if (char === '"') {
      return { value, endIndex: index + 1 }
    }
    if (char === '\\' && index + 1 < line.length) {
      const next = line[index + 1]
      value += unescapeTomlBasicStringEscape(next)
      index += 2
      continue
    }
    value += char
    index++
  }
  return null
}

function parseTomlLiteralSingleLineString(
  line: string,
  startIndex: number
): ParsedTomlString | null {
  const endIndex = line.indexOf("'", startIndex)
  if (endIndex === -1) {
    return null
  }
  return { value: line.slice(startIndex, endIndex), endIndex: endIndex + 1 }
}

function skipTomlInlineWhitespace(line: string, startIndex: number): number {
  let index = startIndex
  while (line[index] === ' ' || line[index] === '\t') {
    index++
  }
  return index
}
// Why: quoted keys can contain `]` (e.g. `[hooks.state."a]b"]`) and `[` lines
// inside multi-line strings aren't headers, so we need a stateful scanner —
// a flat regex misclassifies both cases.
function findNextTableHeader(text: string): number {
  let cursor = 0
  let scanState = createTomlLineScanState()
  while (cursor < text.length) {
    const newlineIdx = text.indexOf('\n', cursor)
    const lineEnd = newlineIdx === -1 ? text.length : newlineIdx
    const rawLine = text.slice(cursor, lineEnd)
    const line = rawLine.replace(/\r$/, '')
    if (isTomlStructuralLine(scanState)) {
      const trimmed = line.trimStart()
      // Why: stop at both `[table]` and `[[array.of.tables]]` — both end our
      // block. Skipping `[[ ]]` here would let our slice consume past array
      // entries into unrelated user content.
      if (trimmed.startsWith('[') && isCompleteTableHeader(trimmed)) {
        return cursor
      }
    }
    scanState = updateTomlLineScanState(scanState, line)
    if (newlineIdx === -1) {
      return -1
    }
    cursor = newlineIdx + 1
  }
  return -1
}

// Why: walk the header byte-by-byte so `]` inside a quoted key segment
// doesn't terminate us early. Basic strings honor `\` escapes; literal
// strings (single quotes) don't allow escapes per TOML spec.
// Accepts both `[table]` and `[[array.of.tables]]` since either ends a block.
function isCompleteTableHeader(line: string): boolean {
  if (!line.startsWith('[')) {
    return false
  }
  const isArrayHeader = line.startsWith('[[')
  let i = isArrayHeader ? 2 : 1
  let inBasicQuote = false
  let inLiteralQuote = false
  while (i < line.length) {
    const ch = line[i]
    if (inBasicQuote) {
      if (ch === '\\' && i + 1 < line.length) {
        i += 2
        continue
      }
      if (ch === '"') {
        inBasicQuote = false
      }
      i++
      continue
    }
    if (inLiteralQuote) {
      if (ch === "'") {
        inLiteralQuote = false
      }
      i++
      continue
    }
    if (ch === '"') {
      inBasicQuote = true
      i++
      continue
    }
    if (ch === "'") {
      inLiteralQuote = true
      i++
      continue
    }
    if (ch === ']') {
      if (isArrayHeader) {
        if (line[i + 1] !== ']') {
          return false
        }
        const tail = line.slice(i + 2)
        return /^\s*(#.*)?$/.test(tail)
      }
      const tail = line.slice(i + 1)
      return /^\s*(#.*)?$/.test(tail)
    }
    i++
  }
  return false
}

// Why: same atomic-rename + .bak rotation pattern as writeHooksJson — a
// half-written config.toml can brick a user's Codex install, so write to
// tmp and rename. Random-suffix tmp name avoids cross-process races on
// rapid reinstalls.
export function writeConfigAtomically(configPath: string, contents: string): void {
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  let renamed = false
  try {
    writeFileSync(tmpPath, contents, 'utf-8')
    if (existsSync(configPath)) {
      copyFileWithWindowsRetry(configPath, `${configPath}.bak`)
    }
    renameFileWithWindowsRetry(tmpPath, configPath)
    renamed = true
  } finally {
    if (!renamed && existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // best effort — surfacing the cleanup failure would mask the original write error
      }
    }
  }
}

export function removeHookTrustEntries(configPath: string, keys: readonly string[]): void {
  if (!existsSync(configPath)) {
    return
  }
  const existing = readTomlFile(configPath)
  let updated = existing
  for (const key of keys) {
    updated = removeTrustBlock(updated, key)
  }
  if (updated === existing) {
    return
  }
  writeConfigAtomically(configPath, updated)
}

function removeTrustBlock(content: string, key: string): string {
  const ranges = findTrustBlockRanges(content, key)
  if (ranges.length === 0) {
    return content
  }

  let cursor = 0
  let updated = ''
  for (const range of ranges) {
    updated += content.slice(cursor, range.start)
    cursor = range.end
  }
  return updated + content.slice(cursor)
}

export function readHookTrustEntries(configPath: string): Map<string, CodexHookTrustState> {
  const result = new HookTrustEntryMap()
  if (!existsSync(configPath)) {
    return result
  }
  const content = readTomlFile(configPath)
  // Why: walk line-by-line so `[hooks.state."..."]` inside a `"""..."""` or
  // `'''...'''` multi-line string isn't mistaken for a real header.
  let cursor = 0
  let scanState = createTomlLineScanState()
  while (cursor < content.length) {
    const newlineIdx = content.indexOf('\n', cursor)
    const lineEnd = newlineIdx === -1 ? content.length : newlineIdx
    const rawLine = content.slice(cursor, lineEnd)
    const line = rawLine.replace(/\r$/, '')
    const nextCursor = newlineIdx === -1 ? content.length : newlineIdx + 1
    const key = isTomlStructuralLine(scanState) ? parseHookStateHeaderKey(line) : null
    if (key !== null) {
      // Why: block ends at the next *real* header (multi-line aware).
      const after = content.slice(nextCursor)
      const nextHeaderRel = findNextTableHeader(after)
      const blockEnd = nextHeaderRel === -1 ? content.length : nextCursor + nextHeaderRel
      const block = content.slice(nextCursor, blockEnd)
      // Why: we own this block's shape (only `enabled` + `trusted_hash`), so
      // a line scan beats pulling in a full TOML value parser.
      const hashMatch = /^[ \t]*trusted_hash[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"/m.exec(block)
      const enabledMatch = /^[ \t]*enabled[ \t]*=[ \t]*(true|false)[ \t\r]*(?:#.*)?$/m.exec(block)
      const normalizedKey = normalizeHookTrustKeyForLookup(key)
      const existingState = result.get(normalizedKey)
      const enabled = enabledMatch ? enabledMatch[1] === 'true' : undefined
      result.set(normalizedKey, {
        trustedHash: hashMatch ? unescapeTomlString(hashMatch[1]) : existingState?.trustedHash,
        // Why: Windows writes both slash variants for one hook; a disabled copy
        // must remain authoritative regardless of which variant appears last.
        enabled:
          existingState?.enabled === false || enabled === false
            ? false
            : (enabled ?? existingState?.enabled)
      })
      cursor = nextCursor
      continue
    }
    scanState = updateTomlLineScanState(scanState, line)
    cursor = nextCursor
  }
  return result
}

function unescapeTomlBasicStringEscape(next: string): string {
  if (next === 'n') {
    return '\n'
  }
  if (next === 'r') {
    return '\r'
  }
  if (next === 't') {
    return '\t'
  }
  if (next === 'b') {
    return '\b'
  }
  if (next === 'f') {
    return '\f'
  }
  if (next === '"') {
    return '"'
  }
  if (next === '\\') {
    return '\\'
  }
  // Why: unknown escapes round-trip — preserve the backslash so we don't
  // silently drop information.
  return `\\${next}`
}

function unescapeTomlString(escaped: string): string {
  let result = ''
  let i = 0
  while (i < escaped.length) {
    const ch = escaped[i]
    if (ch === '\\' && i + 1 < escaped.length) {
      result += unescapeTomlBasicStringEscape(escaped[i + 1])
      i += 2
    } else {
      result += ch
      i++
    }
  }
  return result
}
