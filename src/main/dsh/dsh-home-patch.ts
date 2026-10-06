/**
 * Orca's managed block inside `$DSH_HOME/cordis.patch.yml`.
 *
 * That file is a hand-editable top-level YAML sequence of loader patch entries, and no
 * YAML library is vendored in the main process, so Orca manages only its own
 * marker-delimited region: install rewrites the region, remove strips it, and everything
 * outside the markers is copied through byte for byte. Appending sequence entries to a
 * block sequence is always valid YAML, so the region can live at the end of any file.
 *
 * The one shape that is not append-safe is an empty *flow* sequence (`[]`), which is what
 * DSH writes into a freshly initialized patch file. `- item` after `[]` is a parse error,
 * so that token is dropped when the managed block is added and restored when it is the
 * last thing removed — otherwise the file would come back as an unparseable empty
 * document.
 */

const START_MARKER = '# >>> orca-managed-dsh-hooks (managed by Orca; do not edit) >>>'
const END_MARKER = '# <<< orca-managed-dsh-hooks <<<'

/** The loader row id Orca owns. A patch row is addressed by id, so this must be stable. */
const MANAGED_ROW_ID = 'orca-agent-hooks'

const EMPTY_FLOW_SEQUENCE = '[]'

export type ManagedDshPatchRegion = { startLine: number; endLine: number }

function splitLines(text: string): string[] {
  return text.split('\n')
}

/** Locate the managed region, or null when the file carries none. */
export function findManagedDshPatchRegion(text: string): ManagedDshPatchRegion | null {
  // Why the NEAREST preceding start, not the first one: an interrupted write can leave an
  // orphan start marker with no end. Pairing that orphan with a LATER block's end marker
  // makes the region swallow every row in between — so the next install (which rewrites the
  // region) or remove (which strips it) would delete the user's own rows. Walking forward
  // and resetting the candidate on each start keeps an orphan un-paired, which leaves it as
  // an inert comment line rather than a deletion range.
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

/** Single-quoted YAML scalar: the only escape inside one is a doubled quote. */
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

/** The `configPath` Orca's managed region currently points at, if any. */
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

/** Strips a trailing `# …` so `[] # keep empty` reads as the empty sequence it is. */
function withoutTrailingComment(line: string): string {
  const hash = line.indexOf('#')
  return (hash === -1 ? line : line.slice(0, hash)).trim()
}

/** True when the body is the empty flow sequence, with or without a trailing comment. */
function isEmptyFlowDocument(lines: readonly string[]): boolean {
  const body = documentBody(lines)
  return body.length === 1 && withoutTrailingComment(body[0]) === EMPTY_FLOW_SEQUENCE
}

/**
 * True when Orca cannot append its block to this file: the body is a NON-EMPTY flow
 * sequence (`[a, b]`, or one spread over lines).
 *
 * Why it matters: YAML forbids a block entry after a flow sequence, so appending Orca's
 * `- insert:` would produce a file DSH cannot parse — losing the user's own patch layer as
 * well as Orca's hooks. There is no safe in-place edit, so install refuses instead.
 *
 * Exported because status has to report the same refusal on every read, not just on the
 * install that first hit it.
 */
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

/**
 * Install (or refresh) Orca's managed region so the DSH hook bridge reads
 * `managedHooksPath`. Everything outside the markers is preserved.
 *
 * Returns null when the file cannot be edited safely — see isNonEmptyFlowDocument. The
 * caller reports that; it must never write a file DSH would then fail to parse.
 */
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
  // Why dropped: `- item` after `[]` is a parse error, and an empty sequence has nothing to
  // preserve. Only the token goes — a trailing comment on that line stays.
  const kept = isEmptyFlowDocument(lines)
    ? lines.map((line) =>
        withoutTrailingComment(line) === EMPTY_FLOW_SEQUENCE
          ? line.slice(line.indexOf(EMPTY_FLOW_SEQUENCE) + EMPTY_FLOW_SEQUENCE.length)
          : line
      )
    : lines
  return joinPreservingTrailingNewline([...withoutTrailingBlanks(kept), ...block])
}

/** Strip Orca's managed region, restoring `[]` when nothing else is left. */
export function removeManagedDshPatch(text: string): { text: string; changed: boolean } {
  const region = findManagedDshPatchRegion(text)
  if (!region) {
    return { text, changed: false }
  }
  const kept = withoutTrailingBlanks(stripRegion(splitLines(text), region))
  // Why restore `[]`: a document of comments alone is not a valid entry list, so removing
  // Orca's block must not leave DSH a file it cannot parse.
  const body = kept.every((line) => isBlank(line) || isComment(line))
    ? [...kept, EMPTY_FLOW_SEQUENCE]
    : kept
  return { text: joinPreservingTrailingNewline(body), changed: true }
}
