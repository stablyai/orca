import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'
import { getTomlSections, type TomlSection } from './config-toml-runtime-owned-sections'

/**
 * The section keys the last mirror copied in from the system config.
 *
 * `null` is not an empty set. An empty set claims the source contributed no
 * sections; `null` says no mirror has recorded an answer yet, and no runtime
 * section may be deleted on its authority.
 */
export type MirroredCodexSectionKeys = ReadonlySet<string> | null

/**
 * One key per table, whatever spelling declared it.
 *
 * `[a.b]`, `[ a.b ]`, `[a."b"]` and `[[a.b]]` are all one table to Codex, so
 * they must be one key here. Comparing raw header text instead lets a spelling
 * difference read as "the source does not declare this", and the mirror then
 * emits both — a duplicate table, and a config.toml Codex cannot parse. The
 * array-of-tables marker is dropped deliberately: a table and an array of
 * tables cannot share a name either.
 */
function canonicalTablePath(segments: readonly string[]): string {
  return JSON.stringify(segments)
}

function isPrefixOf(prefix: readonly string[], segments: readonly string[]): boolean {
  return prefix.length <= segments.length && prefix.every((part, index) => segments[index] === part)
}

/** Canonical keys for the tables a config declares with a `[header]`. */
export function getCodexConfigSectionKeys(config: string): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const section of getTomlSections(config)) {
    const parsed = parseTomlTableHeaderPath(section.header)
    if (parsed) {
      keys.add(canonicalTablePath(parsed.segments))
    }
  }
  return keys
}

type DeclaredTableClaims = {
  /** Every table path an assignment closes, including its prefixes. */
  closed: ReadonlySet<string>
  /** Full key paths an assignment binds. Nothing may be declared at or below
   *  one: a scalar or array leaves no table to extend, and TOML forbids
   *  extending an inline table with a sub-table. */
  bindings: readonly (readonly string[])[]
}

/**
 * Table paths the config closes by assigning to them, wherever that happens.
 *
 * A table is declared by more than a `[header]`. `tui = { animations = false }`
 * declares `tui`, `a.b.c = 1` declares `a` and `a.b`, and even `model = "x"`
 * binds `model` so that a later `[model]` is a redefinition rather than an
 * addition. All of it applies inside a table body too, relative to the
 * enclosing header — `[a]` followed by `b.c = 1` closes `a.b`.
 *
 * This scan has to see every such site. A missed one lets the mirror emit a
 * runtime table beside a source name that already owns it, and two declarations
 * of one name is a config.toml Codex refuses to parse.
 */
function readDeclaredTableClaims(config: string): DeclaredTableClaims {
  const closed = new Set<string>()
  const bindings: string[][] = []
  let scanState = createTomlLineScanState()
  // `null` while inside a header this module could not parse: claiming at the
  // wrong depth is worse than claiming nothing, and nothing matches main.
  let enclosing: string[] | null = []
  for (const line of config.split('\n')) {
    if (!isTomlStructuralLine(scanState)) {
      scanState = updateTomlLineScanState(scanState, line)
      continue
    }
    const header = getTomlTableHeader(line)
    if (header !== null) {
      enclosing = parseTomlTableHeaderPath(header)?.segments.slice() ?? null
      scanState = updateTomlLineScanState(scanState, line)
      continue
    }
    const parsed = enclosing === null ? null : parseTomlKeyPath(line)
    if (enclosing !== null && parsed && line.slice(parsed.end).trimStart().startsWith('=')) {
      const path = [...enclosing, ...parsed.segments]
      for (let depth = 1; depth <= path.length; depth += 1) {
        closed.add(canonicalTablePath(path.slice(0, depth)))
      }
      bindings.push(path)
    }
    scanState = updateTomlLineScanState(scanState, line)
  }
  return { closed, bindings }
}

/**
 * Separates a runtime section the user added inside Orca's managed CODEX_HOME
 * from one the mirror copied in and the user has since deleted at the source.
 *
 * Without this the mirror rebuilds every ordinary section from the system
 * config and keeps only a fixed allowlist of runtime-owned tables, so anything
 * written through an Orca-launched Codex — `[mcp_servers.*]` above all — is
 * dropped on the next pass.
 */
export function createRuntimeAddedSectionFilter({
  systemConfig,
  mirroredSectionKeys
}: {
  systemConfig: string
  mirroredSectionKeys: MirroredCodexSectionKeys
}): (section: TomlSection) => boolean {
  const sourceSectionKeys = getCodexConfigSectionKeys(systemConfig)
  const declared = readDeclaredTableClaims(systemConfig)
  return (section) => {
    const parsed = parseTomlTableHeaderPath(section.header)
    // Why: a header that does not parse cannot be compared against the source,
    // and emitting it beside a source table of the same name is what produces
    // an unparseable config. Dropping is also what the mirror did with every
    // ordinary runtime section before this filter existed, so it is no worse.
    if (!parsed) {
      return false
    }
    const key = canonicalTablePath(parsed.segments)
    // Why: the system half of the merge already carries every table it
    // declares, so the source wins for a name present on both sides.
    if (sourceSectionKeys.has(key) || declared.closed.has(key)) {
      return false
    }
    // Why: a bound name owns everything beneath it. `[a.b.env]` cannot extend a
    // source `a = { b = .. }`, and nothing at all can nest under `a = "x"`.
    if (declared.bindings.some((path) => isPrefixOf(path, parsed.segments))) {
      return false
    }
    // Why: recorded as mirrored in and now absent at the source means the user
    // deleted it there, and re-appending it would undo that deletion. With no
    // recorded set the section is kept instead: the managed home is the only
    // copy of anything added inside it, so deleting on a guess is unrecoverable.
    return mirroredSectionKeys === null || !mirroredSectionKeys.has(key)
  }
}
