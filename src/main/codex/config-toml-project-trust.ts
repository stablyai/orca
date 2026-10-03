import { realpathSync } from 'node:fs'
import type { CodexProjectTrustLevel } from './config-toml-trust'
import { normalizeCodexTrustProjectPath } from './codex-trust-identity'
import {
  createTomlLineScanState,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import {
  escapeTomlBasicString,
  findNextTomlTableHeader,
  parseProjectTomlHeaderPath
} from './config-toml-syntax'
import { findProjectTrustLevelEntries } from './config-toml-project-trust-level'
import { repairOrcaDuplicateTrustTables } from './config-toml-project-duplicate-repair'

export function upsertProjectTrustContent(
  existingContent: string,
  projectPath: string,
  trustLevel: CodexProjectTrustLevel,
  options?: { alreadyCanonical?: boolean }
): string {
  const existing = repairOrcaDuplicateTrustTables(stripLeadingBom(existingContent))
  const trustedProjectPath = options?.alreadyCanonical
    ? projectPath
    : canonicalizeLocalProjectPath(projectPath)
  const headerLineEnd = findProjectHeaderLineEnd(existing, trustedProjectPath)
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const trustLine = `trust_level = "${trustLevel}"`
  if (headerLineEnd === null) {
    return appendProjectTrustBlock(existing, trustedProjectPath, trustLine, eol)
  }
  const nextHeaderOffset = findNextTomlTableHeader(existing.slice(headerLineEnd))
  const blockEnd = nextHeaderOffset === -1 ? existing.length : headerLineEnd + nextHeaderOffset
  // Why: rewrite any existing trust_level key, whatever its spelling or value, so none is duplicated.
  const existingEntry = findProjectTrustLevelEntries(existing.slice(headerLineEnd, blockEnd))[0]
  if (existingEntry) {
    return (
      existing.slice(0, headerLineEnd + existingEntry.start) +
      trustLine +
      existing.slice(headerLineEnd + existingEntry.end)
    )
  }
  return `${existing.slice(0, headerLineEnd)}${eol}${trustLine}${existing.slice(headerLineEnd)}`
}

/** Whether `content` already has a table for `projectPath`, in any spelling Codex accepts. */
export function hasProjectTrustTable(content: string, projectPath: string): boolean {
  return findProjectHeaderLineEnd(stripLeadingBom(content), projectPath) !== null
}

/** Whether `content` may still trust `projectPath`: only an explicit `untrusted` or no table says no. */
export function projectTrustTableTrusts(content: string, projectPath: string): boolean {
  const existing = stripLeadingBom(content)
  const headerLineEnd = findProjectHeaderLineEnd(existing, projectPath)
  if (headerLineEnd === null) {
    return false
  }
  const nextHeaderOffset = findNextTomlTableHeader(existing.slice(headerLineEnd))
  const blockEnd = nextHeaderOffset === -1 ? existing.length : headerLineEnd + nextHeaderOffset
  const entry = findProjectTrustLevelEntries(existing.slice(headerLineEnd, blockEnd))[0]
  return entry?.value !== 'untrusted'
}

function canonicalizeLocalProjectPath(projectPath: string): string {
  try {
    return realpathSync.native(projectPath)
  } catch {
    return projectPath
  }
}

function appendProjectTrustBlock(
  existing: string,
  projectPath: string,
  trustLine: string,
  eol: string
): string {
  const block = [`[projects."${escapeTomlBasicString(projectPath)}"]`, trustLine].join(eol)
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

function findProjectHeaderLineEnd(content: string, projectPath: string): number | null {
  const lookupPath = normalizeCodexTrustProjectPath(projectPath)
  let cursor = 0
  let scanState = createTomlLineScanState()
  while (cursor < content.length) {
    const newlineIndex = content.indexOf('\n', cursor)
    const lineEnd = newlineIndex === -1 ? content.length : newlineIndex
    const rawLine = content.slice(cursor, lineEnd)
    const line = rawLine.replace(/\r$/, '')
    const existingPath = isTomlStructuralLine(scanState) ? parseProjectTomlHeaderPath(line) : null
    if (existingPath !== null && normalizeCodexTrustProjectPath(existingPath) === lookupPath) {
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

function stripLeadingBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}
