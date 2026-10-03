import { realpathSync } from 'node:fs'
import type { CodexProjectTrustLevel } from './config-toml-trust'
import { normalizeCodexTrustProjectPath } from './codex-trust-identity'
import { escapeTomlBasicString } from './config-toml-syntax'
import { getTomlTable, type TomlTable } from './codex-config-toml-document'
import {
  applyCheckedCodexConfigTomlEdit,
  CodexConfigTomlEditRefusedError,
  type CodexConfigTomlEditResult
} from './codex-config-toml-checked-edit'
import {
  formatTomlKeyPath,
  getAssignmentKeyPath,
  scanTomlStructure,
  tomlKeyPathsEqual,
  tomlKeyPathStartsWith,
  type TomlAssignmentLine,
  type TomlStructureLine
} from './codex-config-toml-structure'

export function upsertProjectTrustContent(
  existingContent: string,
  projectPath: string,
  trustLevel: CodexProjectTrustLevel,
  options?: { alreadyCanonical?: boolean }
): string {
  const trustedProjectPath = options?.alreadyCanonical
    ? projectPath
    : canonicalizeLocalProjectPath(projectPath)
  const existing = stripLeadingBom(existingContent)
  const updated = applyCheckedCodexConfigTomlEdit(existing, (content, table) =>
    editProjectTrust(content, table, trustedProjectPath, trustLevel)
  )
  return updated === existing ? existingContent : updated
}

/** Decides from the parsed document, so any spelling Codex accepts is found before Orca appends. */
function editProjectTrust(
  content: string,
  table: TomlTable | null,
  projectPath: string,
  trustLevel: CodexProjectTrustLevel
): CodexConfigTomlEditResult {
  const projectKey = findExistingProjectKey(table, projectPath) ?? projectPath
  const trustPath = ['projects', projectKey, 'trust_level']
  const result = (next: string): CodexConfigTomlEditResult => ({
    content: next,
    ownedPaths: [trustPath],
    expected: [{ path: trustPath, value: trustLevel }]
  })
  const project = getTomlTable(getTomlTable(table?.projects)?.[projectKey])
  if (project?.trust_level === trustLevel) {
    return result(content)
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const trustValue = `"${trustLevel}"`
  const lines = scanTomlStructure(content)
  const trustLine = lines.find(
    (line): line is TomlAssignmentLine =>
      line.kind === 'assignment' && pathEquals(getAssignmentKeyPath(line), trustPath)
  )
  if (trustLine) {
    // Why (#22592): a key Codex quoted is rewritten bare, the one spelling Orca writes.
    const bareKey = trustLine.keySegments.length === 1 ? 'trust_level' : null
    return result(replaceAssignmentValue(content, trustLine, trustValue, bareKey))
  }
  const header = lines.find(
    (line) =>
      line.kind === 'table' &&
      !line.isArray &&
      tomlKeyPathsEqual(line.segments, trustPath.slice(0, 2))
  )
  if (header) {
    return result(insertLineAt(content, header, `trust_level = ${trustValue}`, eol))
  }
  const dottedProjectLine = findLastDottedProjectAssignment(lines, trustPath.slice(0, 2))
  if (dottedProjectLine) {
    const relativeKey = formatTomlKeyPath(trustPath.slice(dottedProjectLine.table.segments.length))
    return result(insertLineAt(content, dottedProjectLine, `${relativeKey} = ${trustValue}`, eol))
  }
  const inlineProject = lines.some(
    (line) =>
      line.kind === 'assignment' && pathEquals(getAssignmentKeyPath(line), trustPath.slice(0, 2))
  )
  if (inlineProject) {
    throw new CodexConfigTomlEditRefusedError({
      reason: 'unsupported-form',
      detail: `projects."${projectKey}" is an inline table; set trust_level there or trust the folder in Codex.`
    })
  }
  return result(appendProjectTrustBlock(content, projectKey, `trust_level = ${trustValue}`, eol))
}

function findExistingProjectKey(table: TomlTable | null, projectPath: string): string | null {
  const projects = getTomlTable(table?.projects)
  if (!projects) {
    return null
  }
  if (Object.hasOwn(projects, projectPath)) {
    return projectPath
  }
  const lookupPath = normalizeCodexTrustProjectPath(projectPath)
  return (
    Object.keys(projects).find((key) => normalizeCodexTrustProjectPath(key) === lookupPath) ?? null
  )
}

function pathEquals(path: readonly string[] | null, expected: readonly string[]): boolean {
  return path !== null && tomlKeyPathsEqual(path, expected)
}

/** A project defined only by dotted keys (`"/x".model = …` under `[projects]`) takes its trust as one more dotted key. */
function findLastDottedProjectAssignment(
  lines: readonly TomlStructureLine[],
  projectTablePath: readonly string[]
): TomlAssignmentLine | undefined {
  // Why: no findLast(); the SSH relay bundles this for older Node hosts.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line?.kind !== 'assignment') {
      continue
    }
    const path = getAssignmentKeyPath(line)
    if (
      path !== null &&
      path.length > projectTablePath.length &&
      tomlKeyPathStartsWith(path, projectTablePath) &&
      line.table.segments.length < projectTablePath.length
    ) {
      return line
    }
  }
  return undefined
}

function replaceAssignmentValue(
  content: string,
  line: TomlAssignmentLine,
  renderedValue: string,
  renderedKey: string | null
): string {
  const valueStart = line.lineStart + line.valueOffset
  const rest = content.slice(valueStart, line.contentEnd)
  const stringValue = /^(?:"(?:[^"\\]|\\.)*"|'[^']*')/.exec(rest)
  const valueEnd = stringValue ? valueStart + stringValue[0].length : line.contentEnd
  const keyStart = line.lineStart + line.text.length - line.text.trimStart().length
  const assignment = renderedKey === null ? renderedValue : `${renderedKey} = ${renderedValue}`
  const replaceFrom = renderedKey === null ? valueStart : keyStart
  return content.slice(0, replaceFrom) + assignment + content.slice(valueEnd)
}

function insertLineAt(
  content: string,
  after: TomlStructureLine,
  text: string,
  eol: string
): string {
  const lineEnd = after.contentEnd
  return `${content.slice(0, lineEnd)}${eol}${text}${content.slice(lineEnd)}`
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

function stripLeadingBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}
