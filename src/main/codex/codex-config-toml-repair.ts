import {
  getAssignmentKeyPath,
  getTomlTableBlocks,
  readTomlAssignmentValue,
  scanTomlStructure,
  tomlKeyPathStartsWith,
  tomlKeyPathsEqual,
  type TomlAssignmentLine,
  type TomlTableBlock
} from './codex-config-toml-structure'
import {
  parseCodexConfigToml,
  readTomlValueAtPath,
  tomlValuesEqual,
  type TomlTable
} from './codex-config-toml-document'
import { repairOrcaDuplicateTrustTables } from './config-toml-project-duplicate-repair'

// Why (#22592): earlier Orca builds appended `[projects."<p>"]` beside Codex's
// `["projects"."<p>"]`, inserted a bare `trust_level` beside `"trust_level"`,
// and mirrored a second `[hooks.state]`. TOML rejects each, so every `codex`
// run failed. Orca's exact trust copies go (the user's table wins), then any
// duplicate that carries no value of its own; nothing else is removed.

type TextEdit = {
  start: number
  end: number
  replacement: string
  /** Assignments this edit deletes whose value must survive elsewhere at the same path. */
  removes?: readonly TomlAssignmentLine[]
}

export function repairOrcaCodexConfigDuplicates(content: string): string {
  return repairOrcaCodexConfigDuplicatesWithRemovals(content).content
}

// Why (#22592): a config Orca broke earlier must not carry its duplicates into
// every managed home; launch prep repairs the file itself on the next trust write.
export function repairUnparseableCodexConfig(config: string): string {
  return parseCodexConfigToml(config).ok ? config : repairOrcaCodexConfigDuplicates(config)
}

export type CodexConfigRepair = {
  content: string
  /** Removed assignments whose values a caller must still find, when the repaired file does not parse on its own. */
  unverifiedRemovals: readonly TomlAssignmentLine[]
}

export function repairOrcaCodexConfigDuplicatesWithRemovals(content: string): CodexConfigRepair {
  // Why: returns the content unchanged unless every Orca-shaped trust duplicate could go.
  const trustRepaired = repairOrcaDuplicateTrustTables(content)
  const edits: TextEdit[] = []
  collectDuplicateTableEdits(getTomlTableBlocks(scanTomlStructure(trustRepaired)), edits)
  const repaired = applyTextEdits(trustRepaired, edits)
  const removed = edits.flatMap((edit) => edit.removes ?? [])
  const parsed = parseCodexConfigToml(repaired)
  if (!parsed.ok) {
    return { content: repaired, unverifiedRemovals: removed }
  }
  return removedValuesSurviveIn(parsed.table, removed)
    ? { content: repaired, unverifiedRemovals: [] }
    : { content: trustRepaired, unverifiedRemovals: [] }
}

/** A repair may not lose a value: each removed assignment must still read the same at its path. */
export function removedValuesSurviveIn(
  table: TomlTable,
  removed: readonly TomlAssignmentLine[],
  exemptPaths: readonly (readonly string[])[] = []
): boolean {
  return removed.every((line) => {
    const path = getAssignmentKeyPath(line)
    if (path !== null && exemptPaths.some((exempt) => tomlKeyPathStartsWith(path, exempt))) {
      return true
    }
    return (
      path !== null &&
      tomlValuesEqual(readTomlValueAtPath(table, path), readTomlAssignmentValue(line))
    )
  })
}

function assignments(block: TomlTableBlock): TomlAssignmentLine[] {
  return block.body.filter((line): line is TomlAssignmentLine => line.kind === 'assignment')
}

function collectDuplicateTableEdits(blocks: readonly TomlTableBlock[], edits: TextEdit[]): void {
  const firstByIdentity = new Map<string, TomlTableBlock>()
  const arrayTablePaths: (readonly string[])[] = []
  for (const block of blocks) {
    if (block.header.isArray) {
      arrayTablePaths.push(block.header.segments)
      continue
    }
    // Why: `[s.o]` under two `[[s]]` elements is two tables, not a duplicate.
    if (arrayTablePaths.some((path) => tomlKeyPathStartsWith(block.header.segments, path))) {
      continue
    }
    const identity = JSON.stringify(block.header.segments)
    const first = firstByIdentity.get(identity)
    if (!first) {
      firstByIdentity.set(identity, block)
      continue
    }
    const duplicateAssignments = assignments(block)
    if (duplicateAssignments.length === 0) {
      // Why: a header with no values of its own defines nothing; dropping only
      // the header line keeps any comments under it.
      edits.push(removeLine(block.header))
      continue
    }
    if (duplicateAssignments.every((line) => isValueAlreadyDefined(first, line))) {
      edits.push(removeLine(block.header))
      for (const line of duplicateAssignments) {
        edits.push({ ...removeLine(line), removes: [line] })
      }
    }
  }
}

function isValueAlreadyDefined(first: TomlTableBlock, line: TomlAssignmentLine): boolean {
  const value = readTomlAssignmentValue(line)
  return (
    value !== undefined &&
    assignments(first).some(
      (candidate) =>
        tomlKeyPathsEqual(candidate.keySegments, line.keySegments) &&
        tomlValuesEqual(readTomlAssignmentValue(candidate), value)
    )
  )
}

function removeLine(line: { lineStart: number; nextLineStart: number }): TextEdit {
  return { start: line.lineStart, end: line.nextLineStart, replacement: '' }
}

function applyTextEdits(content: string, edits: readonly TextEdit[]): string {
  // Why: an insert at the offset where a removal starts must survive, so zero-width edits sort first.
  const ordered = [...edits].sort(
    (left, right) =>
      left.start - right.start ||
      Number(left.end !== left.start) - Number(right.end !== right.start) ||
      right.end - left.end
  )
  const disjoint: TextEdit[] = []
  for (const edit of ordered) {
    // Why: a line inside a table already removed whole is removed with it.
    const previous = disjoint.at(-1)
    if (!previous || edit.start >= previous.end) {
      disjoint.push(edit)
    }
  }
  let result = content
  // Why: no toReversed(); the SSH relay runs this on Node 18.
  for (let index = disjoint.length - 1; index >= 0; index -= 1) {
    const edit = disjoint[index]
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
  }
  return result
}
