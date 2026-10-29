import { stripCodexDaemonOverride } from './codex-daemon-socket-path-guard'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlTableHeaderPath } from './config-toml-key-path'
import { findProjectTrustLevelEntries } from './config-toml-project-trust-level'
import { CODEX_HOOK_TRUST_KEY, parseHookStateTomlHeaderKey } from './config-toml-syntax'
import {
  codexHookSourcePathsEqual,
  getCodexExplicitHomeHookSourcePath,
  normalizeCodexProjectPathForLookup,
  normalizeCodexProjectPathForRevocationLookup,
  parseCodexProjectHeaderPath
} from './config-toml-trust'

export type TomlSection = {
  header: string
  block: string
  start: number
}

export type SharedHookTrustCarry = {
  systemHomeDir: string
  /** Decoded hook-trust keys the runtime config already holds. */
  runtimeHookTrustKeys: ReadonlySet<string>
}

export function stripRuntimeOwnedTomlSections(
  config: string,
  runtimeProjectHeaders = new Set<string>(),
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
          !isRuntimeHookTrustTomlSection(section.header) ||
          (sharedHookTrust !== undefined &&
            claimSharedHookTrustSection(section.header, sharedHookTrust, carriedHookTrustKeys))
      )
      .filter(
        (section) =>
          !isRuntimeProjectTomlSection(section.header) ||
          !runtimeProjectHeaders.has(getTomlSectionHeaderKey(section.header)) ||
          getProjectTrustLevel(section.block) === 'untrusted'
      )
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
        start: sectionStart
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
      start: sectionStart
    })
  }
  return sections
}

export function isRuntimePreservedTomlSection(header: string): boolean {
  return isRuntimeHookTrustTomlSection(header) || isRuntimeProjectTomlSection(header)
}

export function isRuntimeHookTrustTomlSection(header: string): boolean {
  const table = parseTomlTableHeaderPath(header)
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
    const key = parseHookStateTomlHeaderKey(section.header)
    if (key !== null) {
      keys.add(key)
    }
  }
  return keys
}

// Runtime trust wins; compare exact keys to retain required Windows separator variants.
function claimSharedHookTrustSection(
  header: string,
  { systemHomeDir }: SharedHookTrustCarry,
  claimedKeys: Set<string>
): boolean {
  const key = parseHookStateTomlHeaderKey(header)
  if (key === null || classifyHookTrustKey(key, systemHomeDir) === 'home-scoped') {
    return false
  }
  if (claimedKeys.has(key)) {
    return false
  }
  claimedKeys.add(key)
  return true
}

export function isRuntimeProjectTomlSection(header: string): boolean {
  return parseCodexProjectHeaderPath(header) !== null
}

const CODEX_MCP_SERVER_TABLE_ROOT = 'mcp_servers'

export function getMcpServerTomlSectionName(header: string): string | null {
  const table = parseTomlTableHeaderPath(header)
  if (!table || table.isArray || table.segments[0] !== CODEX_MCP_SERVER_TABLE_ROOT) {
    return null
  }
  return table.segments[1] ?? null
}

export function getTomlSectionHeaderKey(header: string): string {
  const projectPath = parseCodexProjectHeaderPath(header)
  return projectPath === null
    ? header.trim()
    : `project:${normalizeCodexProjectPathForLookup(projectPath)}`
}

// Match legacy WSL revocations loosely so case drift cannot restore trust.
export function getRevocationTomlSectionHeaderKey(header: string): string {
  const projectPath = parseCodexProjectHeaderPath(header)
  return projectPath === null
    ? header.trim()
    : `project:${normalizeCodexProjectPathForRevocationLookup(projectPath)}`
}

// Deduplicate only projects; hook trust needs distinct Windows separator variants.
export function deduplicateProjectTomlSections(sections: TomlSection[]): TomlSection[] {
  const deduplicated: TomlSection[] = []
  const projectIndexes = new Map<string, number>()
  for (const section of sections) {
    if (!isRuntimeProjectTomlSection(section.header)) {
      deduplicated.push(section)
      continue
    }
    const key = getTomlSectionHeaderKey(section.header)
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
      .filter((section) => isRuntimeProjectTomlSection(section.header))
      .map((section) => getTomlSectionHeaderKey(section.header))
  )
  // The daemon override belongs to the managed home and must not be promoted.
  return stripCodexDaemonOverride(stripRuntimeOwnedTomlSections(config, projectHeaders)).trimEnd()
}
