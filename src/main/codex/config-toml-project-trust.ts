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

export function upsertProjectTrustContent(
  existingContent: string,
  projectPath: string,
  trustLevel: CodexProjectTrustLevel,
  options?: { alreadyCanonical?: boolean }
): string {
  const existing = stripLeadingBom(existingContent)
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
  const existingBlock = existing.slice(headerLineEnd, blockEnd)
  const trustLevelPattern =
    /^[ \t]*trust_level[ \t]*=[ \t]*(?:"(?:trusted|untrusted)"|'(?:trusted|untrusted)')[ \t\r]*(?:#.*)?$/m
  if (trustLevelPattern.test(existingBlock)) {
    return (
      existing.slice(0, headerLineEnd) +
      existingBlock.replace(trustLevelPattern, trustLine) +
      existing.slice(blockEnd)
    )
  }
  return `${existing.slice(0, headerLineEnd)}${eol}${trustLine}${existing.slice(headerLineEnd)}`
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
