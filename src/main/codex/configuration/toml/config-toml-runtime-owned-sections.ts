import { stripCodexDaemonOverride } from '../shared-server/codex-daemon-socket-path-guard'
import { stripCodexSharedSqliteHome } from './config-toml-shared-sqlite-home'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import {
  parseTomlKeyPath,
  parseTomlTableHeaderPath,
  type ParsedTomlTableHeaderPath
} from './config-toml-key-path'
import { findProjectTrustLevelEntries } from '../../trust/toml/config-toml-project-trust-level'
import { CODEX_HOOK_TRUST_KEY } from './config-toml-syntax'
import '../../trust/toml/config-toml-trust'
import {
  codexTrustSourcePathsEqual as codexHookSourcePathsEqual,
  getExplicitHomeCodexHookSourcePath as getCodexExplicitHomeHookSourcePath,
  normalizeCodexTrustProjectPath as normalizeCodexProjectPathForLookup,
  normalizeCodexTrustProjectRevocationPath as normalizeCodexProjectPathForRevocationLookup
} from '../../trust/identity/codex-trust-identity'

export type TomlSection = {
  header: string
  block: string
  start: number
  table: ParsedTomlTableHeaderPath | null
}

export type SharedHookTrustCarry = {
  systemHomeDir: string
  /** Decoded hook-trust keys the runtime config already holds. */
  runtimeHookTrustKeys: ReadonlySet<string>
}

export function stripRuntimeOwnedTomlSections(
  config: string,
  runtimeOwnedHeaders = new Set<string>(),
  sharedHookTrust?: SharedHookTrustCarry
): string {
  const lines = config.split('\n')
  const sourceSections = getTomlSections(config)
  const sections = deduplicateProjectTomlSections(sourceSections)
  const firstSectionIndex = sourceSections[0]?.start ?? -1
  const preamble = firstSectionIndex === -1 ? config : lines.slice(0, firstSectionIndex).join('\n')
  const carriedHookTrustKeys = new Set(sharedHookTrust?.runtimeHookTrustKeys)
  return joinTomlBlocks([
    preamble,
    ...sections
      .filter(
        (section) =>
          !isRuntimeHookTrustTomlSection(section) ||
          (sharedHookTrust !== undefined &&
            claimSharedHookTrustSection(section, sharedHookTrust, carriedHookTrustKeys))
      )
      .filter((section) => {
        const project = isRuntimeProjectTomlSection(section)
        return (
          (!project && !isCodexTuiBookkeepingTomlSection(section)) ||
          !runtimeOwnedHeaders.has(getTomlSectionHeaderKey(section)) ||
          (project && getProjectTrustLevel(section.block) === 'untrusted')
        )
      })
      .map((section) => section.block)
  ])
}

export function getTomlSections(config: string): TomlSection[] {
  const lines = config.split('\n')
  const sections: TomlSection[] = []
  let sectionStart = -1
  let sectionHeader: string | null = null
  let scanState = createTomlLineScanState()

  for (let index = 0; index < lines.length; index += 1) {
    const header = isTomlStructuralLine(scanState) ? getTomlTableHeader(lines[index] ?? '') : null
    if (!header) {
      scanState = updateTomlLineScanState(scanState, lines[index] ?? '')
      continue
    }

    if (sectionStart !== -1) {
      sections.push({
        header: sectionHeader ?? '',
        block: lines.slice(sectionStart, index).join('\n'),
        start: sectionStart,
        table: parseTomlTableHeaderPath(sectionHeader ?? '')
      })
    }
    sectionStart = index
    sectionHeader = header
    scanState = updateTomlLineScanState(scanState, lines[index] ?? '')
  }

  if (sectionStart !== -1) {
    sections.push({
      header: sectionHeader ?? '',
      block: lines.slice(sectionStart).join('\n'),
      start: sectionStart,
      table: parseTomlTableHeaderPath(sectionHeader ?? '')
    })
  }
  return sections
}

export function isRuntimePreservedTomlSection(section: TomlSection): boolean {
  return (
    isRuntimeHookTrustTomlSection(section) ||
    isRuntimeProjectTomlSection(section) ||
    isCodexTuiBookkeepingTomlSection(section)
  )
}

// Codex counts its model tip per session here; replacing it each launch restarts the count.
export function isCodexTuiBookkeepingTomlSection(section: TomlSection): boolean {
  return sectionLeafKey(section, ['tui']) === 'model_availability_nux'
}

/** False when the config defines the tip table any other way, which a kept copy would redefine. */
export function definesCodexTuiBookkeepingOnlyAsTable(config: string): boolean {
  const target = ['tui', 'model_availability_nux']
  const overlaps = (path: readonly string[]): boolean =>
    path.length > 0 &&
    target.every((segment, index) => index >= path.length || path[index] === segment)
  let table: string[] = []
  let state = createTomlLineScanState()
  for (const line of config.split('\n')) {
    const structural = isTomlStructuralLine(state)
    state = updateTomlLineScanState(state, line)
    if (!structural) {
      continue
    }
    const header = getTomlTableHeader(line)
    if (header) {
      const parsed = parseTomlTableHeaderPath(header)
      table = parsed?.segments ?? []
      const exact = !!parsed && !parsed.isArray && table.join('\0') === target.join('\0')
      if (!parsed || (!exact && table.length >= target.length && overlaps(table))) {
        return false
      }
      continue
    }
    const key = parseTomlKeyPath(line)
    if (!key || line[key.end] !== '=') {
      continue
    }
    const path = [...table, ...key.segments]
    if (table.join('\0') !== target.join('\0') && overlaps(path)) {
      return false
    }
  }
  return true
}

export function isRuntimeHookTrustTomlSection(section: TomlSection): boolean {
  const table = section.table
  // Preserve the hooks.state parent Codex materializes on Windows, including quoted spellings.
  return !!table && !table.isArray && table.segments[0] === 'hooks' && table.segments[1] === 'state'
}

// Home-owned hook sources must not be shared between runtime homes.
export function classifyHookTrustKey(key: string, homeDir: string): 'home-scoped' | 'shared' {
  const sourcePath = CODEX_HOOK_TRUST_KEY.exec(key)?.[1]
  if (sourcePath === undefined) {
    // Do not carry keys whose source cannot be attributed.
    return 'home-scoped'
  }
  const homeFiles = ['hooks.json', 'config.toml'].flatMap((file) => {
    // WSL homes require Linux separators even when Orca runs on Windows.
    const logicalPath = `${homeDir.replace(/[\\/]+$/, '')}/${file}`
    return [logicalPath, getCodexExplicitHomeHookSourcePath(logicalPath)]
  })
  return homeFiles.some((homeFile) => codexHookSourcePathsEqual(sourcePath, homeFile))
    ? 'home-scoped'
    : 'shared'
}

export function getHookTrustTomlSectionKeys(sections: readonly TomlSection[]): Set<string> {
  const keys = new Set<string>()
  for (const section of sections) {
    const key = sectionLeafKey(section, ['hooks', 'state'])
    if (key !== null) {
      keys.add(key)
    }
  }
  return keys
}

// Runtime trust wins; compare exact keys to retain required Windows separator variants.
function claimSharedHookTrustSection(
  section: TomlSection,
  { systemHomeDir }: SharedHookTrustCarry,
  claimedKeys: Set<string>
): boolean {
  const key = sectionLeafKey(section, ['hooks', 'state'])
  if (key === null || classifyHookTrustKey(key, systemHomeDir) === 'home-scoped') {
    return false
  }
  if (claimedKeys.has(key)) {
    return false
  }
  claimedKeys.add(key)
  return true
}

function sectionLeafKey(section: TomlSection, parent: readonly string[]): string | null {
  const table = section.table
  if (
    !table ||
    table.isArray ||
    table.segments.length !== parent.length + 1 ||
    parent.some((segment, index) => table.segments[index] !== segment)
  ) {
    return null
  }
  return table.segments.at(-1) ?? null
}

export function isRuntimeProjectTomlSection(section: TomlSection): boolean {
  return sectionLeafKey(section, ['projects']) !== null
}

const CODEX_MCP_SERVER_TABLE_ROOT = 'mcp_servers'

export function getMcpServerTomlSectionName(section: TomlSection): string | null {
  const table = section.table
  if (!table || table.isArray || table.segments[0] !== CODEX_MCP_SERVER_TABLE_ROOT) {
    return null
  }
  return table.segments[1] ?? null
}

export function getTomlSectionHeaderKey(section: TomlSection): string {
  if (isCodexTuiBookkeepingTomlSection(section)) {
    return 'tui:model_availability_nux'
  }
  const projectPath = sectionLeafKey(section, ['projects'])
  return projectPath === null
    ? section.header.trim()
    : `project:${normalizeCodexProjectPathForLookup(projectPath)}`
}

// Match legacy WSL revocations loosely so case drift cannot restore trust.
export function getRevocationTomlSectionHeaderKey(section: TomlSection): string {
  const projectPath = sectionLeafKey(section, ['projects'])
  return projectPath === null
    ? section.header.trim()
    : `project:${normalizeCodexProjectPathForRevocationLookup(projectPath)}`
}

// Deduplicate only projects; hook trust needs distinct Windows separator variants.
export function deduplicateProjectTomlSections(sections: TomlSection[]): TomlSection[] {
  const deduplicated: TomlSection[] = []
  const projectIndexes = new Map<string, number>()
  for (const section of sections) {
    if (!isRuntimeProjectTomlSection(section)) {
      deduplicated.push(section)
      continue
    }
    const key = getTomlSectionHeaderKey(section)
    const existingIndex = projectIndexes.get(key)
    if (existingIndex === undefined) {
      projectIndexes.set(key, deduplicated.length)
      deduplicated.push(section)
      continue
    }
    const existing = deduplicated[existingIndex]
    if (
      existing &&
      getProjectTrustLevel(existing.block) !== 'untrusted' &&
      getProjectTrustLevel(section.block) === 'untrusted'
    ) {
      // Revocation wins regardless of duplicate order.
      deduplicated[existingIndex] = section
    }
  }
  return deduplicated
}

export function getProjectTrustLevel(block: string): 'trusted' | 'untrusted' | null {
  return findProjectTrustLevelEntries(block).find((entry) => entry.value !== null)?.value ?? null
}

export function joinTomlBlocks(blocks: string[]): string {
  const normalizedBlocks = blocks.map((block) => block.trim()).filter((block) => block.length > 0)
  return normalizedBlocks.length === 0 ? '' : `${normalizedBlocks.join('\n\n')}\n`
}

// Seed missing canonical configs from runtime settings while excluding runtime-owned trust.
export function extractOrdinaryCodexSettings(config: string): string {
  const sections = deduplicateProjectTomlSections(getTomlSections(config))
  const projectHeaders = new Set(
    sections
      .filter((section) => isRuntimeProjectTomlSection(section))
      .map((section) => getTomlSectionHeaderKey(section))
  )
  // The daemon override and shared sqlite_home belong to the managed home and must not be promoted.
  return stripCodexSharedSqliteHome(
    stripCodexDaemonOverride(stripRuntimeOwnedTomlSections(config, projectHeaders))
  ).trimEnd()
}
