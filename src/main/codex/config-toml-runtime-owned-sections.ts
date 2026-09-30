import { stripCodexDaemonOverride } from './codex-daemon-socket-path-guard'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlTableHeaderPath } from './config-toml-key-path'
import { findProjectTrustLevelEntries } from './config-toml-project-trust-level'
import { parseHookStateTomlHeaderKey } from './config-toml-syntax'
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
  // Why: Codex's config writer materializes the parent table on Windows. It is
  // part of runtime-owned trust and must survive the next config mirror too.
  // Its `["hooks"."state"]` spelling is the same table (#22592).
  return !!table && !table.isArray && table.segments[0] === 'hooks' && table.segments[1] === 'state'
}

// Why: Codex's `{source}:{event}:{group}:{handler}` for any label, incl. session_end/interrupt.
const CODEX_HOOK_TRUST_KEY = /^(.+):[a-z_]+:(?:0|[1-9]\d*):(?:0|[1-9]\d*)$/

// Why: user-layer keys name the home's own hooks.json/config.toml; plugin/project keys don't.
export function classifyHookTrustKey(key: string, homeDir: string): 'home-scoped' | 'shared' {
  const sourcePath = CODEX_HOOK_TRUST_KEY.exec(key)?.[1]
  if (sourcePath === undefined) {
    // Why: Codex never writes another key shape; carry nothing we cannot attribute.
    return 'home-scoped'
  }
  const homeFiles = ['hooks.json', 'config.toml'].flatMap((file) => {
    // Why: not path.join; a WSL home is a Linux path even when Orca runs on Windows.
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

// Why: runtime copy wins, else a duplicate table breaks Codex; exact keys keep slash variants apart.
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

/** Returns the decoded MCP server name for an owner table or nested descendant. */
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

// Why: configs written before WSL tails compared case-sensitively can hold a
// revocation under drifted casing; match it loosely so trust is not resurrected.
export function getRevocationTomlSectionHeaderKey(header: string): string {
  const projectPath = parseCodexProjectHeaderPath(header)
  return projectPath === null
    ? header.trim()
    : `project:${normalizeCodexProjectPathForRevocationLookup(projectPath)}`
}

// Why: hook upsert already removes both quote representations, while its paired
// Windows slash variants are required for Codex 0.140 and must remain distinct.
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
      // Why: revocation must survive self-healing regardless of duplicate order.
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

// Why: with no ~/.codex/config.toml the runtime config is the user's only
// config, so promotion seeds ~/.codex from it. Trust is runtime-owned and the
// mirror re-appends it, so drop every project and hook-trust table here.
export function extractOrdinaryCodexSettings(config: string): string {
  const sections = deduplicateProjectTomlSections(getTomlSections(config))
  const projectHeaders = new Set(
    sections
      .filter((section) => isRuntimeProjectTomlSection(section.header))
      .map((section) => getTomlSectionHeaderKey(section.header))
  )
  // Why: the daemon override exists only because Orca's home path is long; ~/.codex is not.
  return stripCodexDaemonOverride(stripRuntimeOwnedTomlSections(config, projectHeaders)).trimEnd()
}
