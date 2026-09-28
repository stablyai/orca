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

/** Codex's recorded answer for a project; `unrecognized` is a value Codex itself cannot load. */
export type CodexProjectTrustDecision = CodexProjectTrustLevel | 'unrecognized'

type ProjectTrustLookupOptions = { alreadyCanonical?: boolean }

export function readProjectTrustDecisionFromContent(
  content: string,
  projectPath: string,
  options?: ProjectTrustLookupOptions
): CodexProjectTrustDecision | null {
  const existing = stripLeadingBom(content)
  const block = findProjectBlock(existing, resolveLookupPath(projectPath, options))
  return block === null ? null : readBlockTrustDecision(existing.slice(block.start, block.end))
}

// Why: a project Codex already has an answer for is the user's choice, so only an unanswered one is added.
export function addProjectTrustContent(
  existingContent: string,
  projectPath: string,
  trustLevel: CodexProjectTrustLevel,
  options?: ProjectTrustLookupOptions
): string {
  const existing = stripLeadingBom(existingContent)
  const trustedProjectPath = resolveLookupPath(projectPath, options)
  const block = findProjectBlock(existing, trustedProjectPath)
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const trustLine = `trust_level = "${trustLevel}"`
  if (block === null) {
    return appendProjectTrustBlock(existing, trustedProjectPath, trustLine, eol)
  }
  if (readBlockTrustDecision(existing.slice(block.start, block.end)) !== null) {
    return existingContent
  }
  return `${existing.slice(0, block.start)}${eol}${trustLine}${existing.slice(block.start)}`
}

function resolveLookupPath(projectPath: string, options?: ProjectTrustLookupOptions): string {
  return options?.alreadyCanonical ? projectPath : canonicalizeLocalProjectPath(projectPath)
}

function readBlockTrustDecision(block: string): CodexProjectTrustDecision | null {
  const match = /^[ \t]*(["']?)trust_level\1[ \t]*=(.*)$/m.exec(block)
  if (!match) {
    return null
  }
  const value = /^[ \t]*(?:"(trusted|untrusted)"|'(trusted|untrusted)')[ \t\r]*(?:#.*)?$/.exec(
    match[2] ?? ''
  )
  const level = value?.[1] ?? value?.[2]
  return level === 'trusted' || level === 'untrusted' ? level : 'unrecognized'
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

function findProjectBlock(
  content: string,
  projectPath: string
): { start: number; end: number } | null {
  const headerLineEnd = findProjectHeaderLineEnd(content, projectPath)
  if (headerLineEnd === null) {
    return null
  }
  const nextHeaderOffset = findNextTomlTableHeader(content.slice(headerLineEnd))
  return {
    start: headerLineEnd,
    end: nextHeaderOffset === -1 ? content.length : headerLineEnd + nextHeaderOffset
  }
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
