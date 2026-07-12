import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import { rewriteRelativePathConfigValues } from './codex-config-path-reference-rewrite'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  promoteCodexRuntimeSettingsToSystem,
  snapshotCodexRuntimeSettingsBaseline,
  type CodexSettingsPromotionHomes
} from './config-settings-promotion'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import {
  normalizeCodexProjectPathForLookup,
  parseCodexProjectHeaderPath
} from './config-toml-trust'

export function syncSystemConfigIntoManagedCodexHome(
  homes: CodexSettingsPromotionHomes = {
    runtimeHomePath: getOrcaManagedCodexHomePath(),
    systemHomePath: getSystemCodexHomePath()
  }
): void {
  // Why: the mirror overwrites runtime settings from ~/.codex, so changes the
  // user made inside Orca-launched Codex (/model, /approvals) must be written
  // back to ~/.codex first or this very pass silently reverts them.
  if (!promoteCodexRuntimeSettingsToSystem(homes)) {
    // Why: mirroring after a failed write-back would erase the runtime change;
    // leave both runtime and its old baseline intact so the next launch retries.
    return
  }
  try {
    syncSystemConfigIntoManagedCodexHomeUnsafe(homes)
  } catch (error) {
    console.warn('[codex-config] Failed to mirror system Codex config:', error)
    return
  }
  // Why: the baseline advances only after a successful mirror; recording an
  // unpromoted runtime change as Orca-written would strand it forever.
  snapshotCodexRuntimeSettingsBaseline(homes.runtimeHomePath)
}

function syncSystemConfigIntoManagedCodexHomeUnsafe({
  runtimeHomePath,
  systemHomePath
}: CodexSettingsPromotionHomes): void {
  const systemConfigPath = join(systemHomePath, 'config.toml')
  const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
  const systemConfigExists = existsSync(systemConfigPath)
  const runtimeConfigExists = existsSync(runtimeConfigPath)
  if (!systemConfigExists && !runtimeConfigExists) {
    return
  }

  const rawSystemConfig = systemConfigExists ? readFileSync(systemConfigPath, 'utf-8') : ''
  const sourceConfigDir = resolveCodexConfigMirrorSourceDirectory(systemHomePath)
  if (!runtimeConfigExists) {
    writeFileAtomically(
      runtimeConfigPath,
      prepareSystemConfigForFreshRuntimeMirror(rawSystemConfig, sourceConfigDir)
    )
    return
  }

  const systemConfig = prepareSystemConfigForRuntimeMirror(rawSystemConfig, sourceConfigDir)
  const runtimeConfig = readFileSync(runtimeConfigPath, 'utf-8')
  const mergedConfig = mergeSystemCodexConfigIntoRuntime(runtimeConfig, systemConfig)
  if (mergedConfig !== runtimeConfig) {
    writeFileAtomically(runtimeConfigPath, mergedConfig)
  }
}

export function resolveCodexConfigMirrorSourceDirectory(systemHomePath: string): string {
  return parseWslUncPath(systemHomePath)?.linuxPath ?? dirname(join(systemHomePath, 'config.toml'))
}

function prepareSystemConfigForRuntimeMirror(config: string, systemConfigDir: string): string {
  return rewriteRelativePathConfigValues(
    normalizeDeprecatedCodexHookFeatureFlag(config),
    systemConfigDir
  )
}

// Why: trust blocks reference a hooks.json path, so system-home hook trust
// entries are not valid in a fresh runtime CODEX_HOME until install remaps
// them. Also seeds WSL runtime homes, where systemConfigDir must be the
// Linux-side ~/.codex the config resolves against inside the distro.
export function prepareSystemConfigForFreshRuntimeMirror(
  config: string,
  systemConfigDir: string
): string {
  return stripRuntimeOwnedTomlSections(prepareSystemConfigForRuntimeMirror(config, systemConfigDir))
}

function normalizeDeprecatedCodexHookFeatureFlag(config: string): string {
  if (!config.includes('codex_hooks')) {
    return config
  }

  const lines = config.split('\n')
  const featureSections: { start: number; end: number }[] = []
  let featureStart: number | null = null

  for (let index = 0; index <= lines.length; index += 1) {
    const line = lines[index]
    // Why: CRLF configs keep a trailing \r after the split, so header anchors
    // must tolerate it or Windows-shaped configs skip normalization entirely.
    const isHeader = line === undefined || /^[ \t]*\[[^\]]+\][ \t]*(?:#.*)?\r?$/.test(line)
    if (!isHeader) {
      continue
    }

    if (featureStart !== null) {
      featureSections.push({ start: featureStart, end: index })
      featureStart = null
    }
    if (line !== undefined && /^[ \t]*\[features\][ \t]*(?:#.*)?\r?$/.test(line)) {
      featureStart = index
    }
  }

  for (const section of featureSections.toReversed()) {
    normalizeFeatureSectionLines(lines, section.start + 1, section.end)
  }
  return lines.join('\n')
}

function normalizeFeatureSectionLines(lines: string[], start: number, end: number): void {
  const deprecatedIndexes: number[] = []
  let hasHooksKey = false
  for (let index = start; index < end; index += 1) {
    const line = lines[index] ?? ''
    if (/^[ \t]*hooks[ \t]*=/.test(line)) {
      hasHooksKey = true
    }
    if (/^[ \t]*codex_hooks[ \t]*=/.test(line)) {
      deprecatedIndexes.push(index)
    }
  }
  if (deprecatedIndexes.length === 0) {
    return
  }

  if (!hasHooksKey) {
    const firstDeprecatedIndex = deprecatedIndexes.shift()
    if (firstDeprecatedIndex !== undefined) {
      // Why: Codex 0.133 warns on the old key. Mirror into Orca's runtime
      // config using the new key without rewriting the user's real config.
      lines[firstDeprecatedIndex] = lines[firstDeprecatedIndex]!.replace(
        /^([ \t]*)codex_hooks([ \t]*=)/,
        '$1hooks$2'
      )
    }
  }

  for (const index of deprecatedIndexes.toReversed()) {
    lines.splice(index, 1)
  }
}

function mergeSystemCodexConfigIntoRuntime(runtimeConfig: string, systemConfig: string): string {
  const runtimeSections = deduplicateProjectTomlSections(getTomlSections(runtimeConfig))
  const runtimeProjectHeaders = new Set(
    runtimeSections
      .filter((section) => isRuntimeProjectTomlSection(section.header))
      .map((section) => getTomlSectionHeaderKey(section.header))
  )
  const systemUntrustedProjectHeaders = new Set(
    deduplicateProjectTomlSections(getTomlSections(systemConfig))
      .filter((section) => isRuntimeProjectTomlSection(section.header))
      .filter((section) => getProjectTrustLevel(section.block) === 'untrusted')
      .map((section) => getTomlSectionHeaderKey(section.header))
  )
  // Why: ordinary Codex settings should mirror ~/.codex exactly; runtime hook
  // trust and project trust are written under Orca's managed CODEX_HOME and
  // must survive the copy unless the user explicitly revoked project trust in
  // the system config.
  return joinTomlBlocks([
    stripRuntimeOwnedTomlSections(systemConfig, runtimeProjectHeaders),
    ...runtimeSections
      .filter((section) => isRuntimePreservedTomlSection(section.header))
      .filter(
        (section) =>
          !isRuntimeProjectTomlSection(section.header) ||
          !systemUntrustedProjectHeaders.has(getTomlSectionHeaderKey(section.header))
      )
      .map((section) => section.block)
  ])
}

type TomlSection = {
  header: string
  block: string
  start: number
}

function stripRuntimeOwnedTomlSections(
  config: string,
  runtimeProjectHeaders = new Set<string>()
): string {
  const lines = config.split('\n')
  const sourceSections = getTomlSections(config)
  const sections = deduplicateProjectTomlSections(sourceSections)
  const firstSectionIndex = sourceSections[0]?.start ?? -1
  const preamble = firstSectionIndex === -1 ? config : lines.slice(0, firstSectionIndex).join('\n')
  return joinTomlBlocks([
    preamble,
    ...sections
      .filter((section) => !isRuntimeHookTrustTomlSection(section.header))
      .filter(
        (section) =>
          !isRuntimeProjectTomlSection(section.header) ||
          !runtimeProjectHeaders.has(getTomlSectionHeaderKey(section.header)) ||
          getProjectTrustLevel(section.block) === 'untrusted'
      )
      .map((section) => section.block)
  ])
}

function getTomlSections(config: string): TomlSection[] {
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

function isRuntimePreservedTomlSection(header: string): boolean {
  return isRuntimeHookTrustTomlSection(header) || isRuntimeProjectTomlSection(header)
}

function isRuntimeHookTrustTomlSection(header: string): boolean {
  return header.trimStart().startsWith('[hooks.state.')
}

function isRuntimeProjectTomlSection(header: string): boolean {
  return parseCodexProjectHeaderPath(header) !== null
}

function getTomlSectionHeaderKey(header: string): string {
  const projectPath = parseCodexProjectHeaderPath(header)
  return projectPath === null
    ? header.trim()
    : `project:${normalizeCodexProjectPathForLookup(projectPath)}`
}

// Why: hook upsert already removes both quote representations, while its paired
// Windows slash variants are required for Codex 0.140 and must remain distinct.
function deduplicateProjectTomlSections(sections: TomlSection[]): TomlSection[] {
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

function getProjectTrustLevel(block: string): 'trusted' | 'untrusted' | null {
  const match =
    /^[ \t]*trust_level[ \t]*=[ \t]*(?:"(trusted|untrusted)"|'(trusted|untrusted)')[ \t\r]*(?:#.*)?$/m.exec(
      block
    )
  const trustLevel = match?.[1] ?? match?.[2] ?? null
  return trustLevel === 'trusted' || trustLevel === 'untrusted' ? trustLevel : null
}

function joinTomlBlocks(blocks: string[]): string {
  const normalizedBlocks = blocks.map((block) => block.trim()).filter((block) => block.length > 0)
  return normalizedBlocks.length === 0 ? '' : `${normalizedBlocks.join('\n\n')}\n`
}
