import { readMcpServerTomlOwnership } from './config-toml-mcp-servers'
import { getTomlTable, parseCodexConfigToml } from './codex-config-toml-document'
import { repairUnparseableCodexConfig } from './codex-config-toml-repair'
import { normalizeCodexProjectPathForLookup } from './config-toml-trust'
import {
  deduplicateProjectTomlSections,
  getHookTrustTomlSectionKeys,
  getMcpServerTomlSectionName,
  getProjectTrustLevel,
  getRevocationTomlSectionHeaderKey,
  getTomlSectionHeaderKey,
  getTomlSections,
  isRuntimePreservedTomlSection,
  isRuntimeProjectTomlSection,
  joinTomlBlocks,
  stripRuntimeOwnedTomlSections
} from './config-toml-runtime-owned-sections'
import { parseTomlTableHeaderPath } from './config-toml-key-path'
import { mayNameTomlKeys, parseProjectTomlHeaderPath } from './config-toml-syntax'

/** Ordinary settings and shared hook trust from ~/.codex plus the tables the managed home owns. */
export function mergeSystemCodexConfigIntoRuntime(
  runtimeConfig: string,
  systemConfig: string,
  systemConfigDir: string,
  mirroredMcpServerNames: ReadonlySet<string> = new Set(),
  mirroredMcpServerRoot = false
): string {
  const systemInlineProjects = getProjectsDefinedOutsideTables(systemConfig)
  const runtimeSections = deduplicateProjectTomlSections(
    getTomlSections(repairUnparseableCodexConfig(runtimeConfig))
  ).filter(
    // Why: ~/.codex defines this project inline or with dotted keys, so a
    // runtime `[projects."…"]` table beside it would redefine it.
    (section) =>
      !isRuntimeProjectTomlSection(section.header) ||
      !systemInlineProjects.has(getTomlSectionHeaderKey(section.header))
  )
  const runtimeProjectHeaders = new Set(
    runtimeSections
      .filter((section) => isRuntimeProjectTomlSection(section.header))
      .map((section) => getTomlSectionHeaderKey(section.header))
  )
  const systemProjectSections = deduplicateProjectTomlSections(
    getTomlSections(systemConfig)
  ).filter((section) => isRuntimeProjectTomlSection(section.header))
  const systemUntrustedProjectHeaders = new Set(
    systemProjectSections
      .filter((section) => getProjectTrustLevel(section.block) === 'untrusted')
      .map((section) => getRevocationTomlSectionHeaderKey(section.header))
  )
  // Why: an exact-cased trusted entry in ~/.codex is the user's latest explicit
  // decision for that exact project; a loosely-matched (case-drifted) revocation
  // must not override it, or re-granting trust would be reverted every mirror.
  const systemTrustedProjectHeaders = new Set(
    systemProjectSections
      .filter((section) => getProjectTrustLevel(section.block) === 'trusted')
      .map((section) => getTomlSectionHeaderKey(section.header))
  )
  const systemMcpServers = readMcpServerTomlOwnership(systemConfig)
  // Why: ordinary Codex settings should mirror ~/.codex exactly; runtime hook
  // trust and project trust are written under Orca's managed CODEX_HOME and
  // must survive the copy unless the user explicitly revoked project trust in
  // the system config.
  return joinTomlBlocks([
    stripRuntimeOwnedTomlSections(systemConfig, runtimeProjectHeaders, {
      systemHomeDir: systemConfigDir,
      runtimeHookTrustKeys: getHookTrustTomlSectionKeys(runtimeSections)
    }),
    ...runtimeSections
      .filter((section) => {
        if (isRuntimePreservedTomlSection(section.header)) {
          return true
        }
        const mcpServerName = getMcpServerTomlSectionName(section.header)
        return (
          mcpServerName !== null &&
          !systemMcpServers.ownsRoot &&
          !mirroredMcpServerRoot &&
          !systemMcpServers.names.has(mcpServerName) &&
          !mirroredMcpServerNames.has(mcpServerName)
        )
      })
      .filter(
        (section) =>
          !isRuntimeProjectTomlSection(section.header) ||
          !systemUntrustedProjectHeaders.has(getRevocationTomlSectionHeaderKey(section.header)) ||
          systemTrustedProjectHeaders.has(getTomlSectionHeaderKey(section.header))
      )
      .map((section) => section.block)
  ])
}

/** Project keys ~/.codex defines inline or with dotted keys rather than as `[projects."…"]` tables. */
function getProjectsDefinedOutsideTables(config: string): ReadonlySet<string> {
  const parsed = parseCodexConfigToml(config)
  const projects = parsed.ok ? getTomlTable(parsed.table.projects) : null
  if (!projects) {
    return new Set()
  }
  // Header paths below each project, JSON-encoded; `[]` is the project's own header.
  const headerPaths = new Map<string, Set<string>>()
  for (const { header } of getTomlSections(config)) {
    if (!mayNameTomlKeys(header, ['projects'])) {
      continue
    }
    const projectPath = parseProjectTomlHeaderPath(header)
    const [root, subProjectPath, ...rest] =
      projectPath === null
        ? (parseTomlTableHeaderPath(header)?.segments ?? [])
        : ['projects', projectPath]
    if (root === 'projects' && subProjectPath !== undefined) {
      const key = projectKey(subProjectPath)
      headerPaths.set(key, (headerPaths.get(key) ?? new Set()).add(JSON.stringify(rest)))
    }
  }
  return new Set(
    Object.entries(projects)
      .filter(
        ([projectPath, value]) =>
          !isDefinedByHeaders(value, [], headerPaths.get(projectKey(projectPath)) ?? new Set())
      )
      .map(([projectPath]) => projectKey(projectPath))
  )
}

// Why: `[projects."/a".extra]` defines `/a` as a table only when no dotted or
// inline key sets a value anywhere under `/a` outside a header.
function isDefinedByHeaders(
  value: unknown,
  path: readonly string[],
  headerPaths: ReadonlySet<string>
): boolean {
  if (headerPaths.has(JSON.stringify(path))) {
    return true
  }
  const table = getTomlTable(value)
  return (
    table !== null &&
    Object.keys(table).length > 0 &&
    Object.entries(table).every(([name, child]) =>
      isDefinedByHeaders(child, [...path, name], headerPaths)
    )
  )
}

function projectKey(projectPath: string): string {
  return `project:${normalizeCodexProjectPathForLookup(projectPath)}`
}
