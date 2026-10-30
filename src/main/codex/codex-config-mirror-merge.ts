import { readMcpServerTomlOwnership } from './config-toml-mcp-servers'
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

/** Ordinary settings and shared hook trust from ~/.codex plus the tables the managed home owns. */
export function mergeSystemCodexConfigIntoRuntime(
  runtimeConfig: string,
  systemConfig: string,
  systemConfigDir: string,
  mirroredMcpServerNames: ReadonlySet<string> = new Set(),
  mirroredMcpServerRoot = false
): string {
  const runtimeSections = deduplicateProjectTomlSections(getTomlSections(runtimeConfig))
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
  // Exact-cased re-grants must override legacy case-drifted revocations or each mirror reverts trust.
  const systemTrustedProjectHeaders = new Set(
    systemProjectSections
      .filter((section) => getProjectTrustLevel(section.block) === 'trusted')
      .map((section) => getTomlSectionHeaderKey(section.header))
  )
  const systemMcpServers = readMcpServerTomlOwnership(systemConfig)
  // Mirror ordinary settings while retaining runtime trust, subject to explicit system project revocations.
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
