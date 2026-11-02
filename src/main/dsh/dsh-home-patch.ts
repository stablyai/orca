/** Edit only Orca's marker-delimited region in the user-owned YAML patch layer. */

const START_MARKER = '# >>> orca-managed-dsh-hooks (managed by Orca; do not edit) >>>'
const END_MARKER = '# <<< orca-managed-dsh-hooks <<<'

/** DSH targets patch rows by ID, so keep this stable. */
const MANAGED_ROW_ID = 'orca-agent-hooks'

const EMPTY_FLOW_SEQUENCE = '[]'

export type ManagedDshPatchRegion = { startLine: number; endLine: number }

function splitLines(text: string): string[] {
  return text.split('\n')
}

export function findManagedDshPatchRegion(text: string): ManagedDshPatchRegion | null {
  // Use the nearest start marker so orphan starts cannot extend deletion across user rows.
  let startLine = -1
  for (const [index, line] of splitLines(text).entries()) {
    const trimmed = line.trim()
    if (trimmed === START_MARKER) {
      startLine = index
    } else if (trimmed === END_MARKER && startLine !== -1) {
      return { startLine, endLine: index }
    }
  }
  return null
}

function buildManagedBlock(managedHooksPath: string): string[] {
  return [
    START_MARKER,
    '- insert:',
    `    - id: ${MANAGED_ROW_ID}`,
    "      name: '@deepseek-ai/dsh-hooks-claude-code'",
    '      config:',
    `        configPath: ${quoteYamlScalar(managedHooksPath)}`,
    END_MARKER
  ]
}

function quoteYamlScalar(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replaceAll("''", "'")
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function readManagedDshHooksConfigPath(text: string): string | undefined {
  const region = findManagedDshPatchRegion(text)
  if (!region) {
    return undefined
  }
  for (const line of splitLines(text).slice(region.startLine + 1, region.endLine)) {
    const match = /^\s*configPath:\s*(.+?)\s*$/.exec(line)
    if (match) {
      return unquoteYamlScalar(match[1])
    }
  }
  return undefined
}

function stripRegion(lines: string[], region: ManagedDshPatchRegion): string[] {
  return [...lines.slice(0, region.startLine), ...lines.slice(region.endLine + 1)]
}

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

function isComment(line: string): boolean {
  return line.trim().startsWith('#')
}

function documentBody(lines: readonly string[]): readonly string[] {
  return lines.filter((line) => !isBlank(line) && !isComment(line))
}

function withoutTrailingComment(line: string): string {
  const hash = line.indexOf('#')
  return (hash === -1 ? line : line.slice(0, hash)).trim()
}

function isEmptyFlowDocument(lines: readonly string[]): boolean {
  const body = documentBody(lines)
  return body.length === 1 && withoutTrailingComment(body[0]) === EMPTY_FLOW_SEQUENCE
}

/** Reject nonempty flow sequences: appending block entries would invalidate the user's patch layer. */
export function isDshPatchFileUnappendable(text: string): boolean {
  const lines = splitLines(text)
  const body = documentBody(lines)
  return body.length > 0 && body[0].trimStart().startsWith('[') && !isEmptyFlowDocument(lines)
}

function withoutTrailingBlanks(lines: readonly string[]): readonly string[] {
  const end = lines.findLastIndex((line) => !isBlank(line))
  return lines.slice(0, end + 1)
}

function joinPreservingTrailingNewline(lines: readonly string[]): string {
  const text = lines.join('\n')
  return text.endsWith('\n') || text.length === 0 ? text : `${text}\n`
}

/** Return null when appending the managed block would make the YAML invalid. */
export function applyManagedDshPatch(text: string, managedHooksPath: string): string | null {
  const lines = splitLines(text)
  const block = buildManagedBlock(managedHooksPath)
  const region = findManagedDshPatchRegion(text)
  if (region) {
    return joinPreservingTrailingNewline([
      ...lines.slice(0, region.startLine),
      ...block,
      ...lines.slice(region.endLine + 1)
    ])
  }
  if (isDshPatchFileUnappendable(text)) {
    return null
  }
  // Drop only the empty [] token; YAML cannot append block entries after a flow sequence.
  const kept = isEmptyFlowDocument(lines)
    ? lines.map((line) =>
        withoutTrailingComment(line) === EMPTY_FLOW_SEQUENCE
          ? line.slice(line.indexOf(EMPTY_FLOW_SEQUENCE) + EMPTY_FLOW_SEQUENCE.length)
          : line
      )
    : lines
  return joinPreservingTrailingNewline([...withoutTrailingBlanks(kept), ...block])
}

export function removeManagedDshPatch(text: string): { text: string; changed: boolean } {
  const region = findManagedDshPatchRegion(text)
  if (!region) {
    return { text, changed: false }
  }
  const kept = withoutTrailingBlanks(stripRegion(splitLines(text), region))
  // Restore an empty sequence because a comments-only document is not a patch-entry list.
  const body = kept.every((line) => isBlank(line) || isComment(line))
    ? [...kept, EMPTY_FLOW_SEQUENCE]
    : kept
  return { text: joinPreservingTrailingNewline(body), changed: true }
}
