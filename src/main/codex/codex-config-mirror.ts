/* eslint-disable max-lines -- Why: keeping Codex config merge policy beside
the TOML section scanner makes precedence between system config, runtime
preferences, and trust state auditable in one place. */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import {
  getSystemCodexConfigDigest,
  readLastSyncedSystemCodexConfigState,
  writeLastSyncedMirrorableSystemCodexConfigDigest,
  writeLastSyncedMirrorableSystemCodexConfigDigestOnly,
  writeLastSyncedMirrorableSystemCodexConfigDigestValue
} from './codex-config-sync-state'

function getRuntimeCodexConfigTomlPath(): string {
  return join(getOrcaManagedCodexHomePath(), 'config.toml')
}

function getSystemCodexConfigTomlPath(): string {
  return join(getSystemCodexHomePath(), 'config.toml')
}

export function syncSystemConfigIntoManagedCodexHome(): void {
  try {
    syncSystemConfigIntoManagedCodexHomeUnsafe()
  } catch (error) {
    console.warn('[codex-config] Failed to mirror system Codex config:', error)
  }
}

function syncSystemConfigIntoManagedCodexHomeUnsafe(): void {
  const systemConfigPath = getSystemCodexConfigTomlPath()
  const runtimeConfigPath = getRuntimeCodexConfigTomlPath()
  const systemConfigExists = existsSync(systemConfigPath)
  const runtimeConfigExists = existsSync(runtimeConfigPath)
  if (!systemConfigExists && !runtimeConfigExists) {
    return
  }

  const systemConfig = normalizeDeprecatedCodexHookFeatureFlag(
    systemConfigExists ? readFileSync(systemConfigPath, 'utf-8') : ''
  )
  const systemConfigUnits = getSystemConfigUnits(systemConfig)
  const systemConfigUnitDigests = getSystemConfigUnitDigestRecord(systemConfigUnits)
  const mirrorableSystemConfig = getMirrorableSystemCodexConfig(systemConfig)
  const lastSyncedSystemConfig = readLastSyncedSystemCodexConfigState()
  const lastSyncedMirrorableSystemConfig =
    lastSyncedSystemConfig.status === 'legacy'
      ? {
          status: 'valid' as const,
          digest: getSystemCodexConfigDigest(
            getMirrorableSystemCodexConfig(
              normalizeDeprecatedCodexHookFeatureFlag(lastSyncedSystemConfig.systemConfig)
            )
          ),
          unitDigests: getSystemConfigUnitDigestRecord(
            getSystemConfigUnits(
              normalizeDeprecatedCodexHookFeatureFlag(lastSyncedSystemConfig.systemConfig)
            )
          ),
          needsRewrite: true
        }
      : lastSyncedSystemConfig
  if (!runtimeConfigExists) {
    // Why: trust blocks reference a hooks.json path, so system-home hook trust
    // entries are not valid in Orca's runtime CODEX_HOME until install remaps them.
    writeFileAtomically(runtimeConfigPath, stripRuntimeOwnedTomlSections(systemConfig))
    writeLastSyncedMirrorableSystemCodexConfigDigest(
      mirrorableSystemConfig,
      systemConfigUnitDigests
    )
    return
  }

  if (!systemConfigExists) {
    if (lastSyncedMirrorableSystemConfig.status !== 'valid') {
      return
    }
    if (lastSyncedMirrorableSystemConfig.unitDigests === null) {
      if (lastSyncedMirrorableSystemConfig.needsRewrite) {
        writeLastSyncedMirrorableSystemCodexConfigDigestOnly(
          lastSyncedMirrorableSystemConfig.digest
        )
      }
      return
    }
    if (lastSyncedMirrorableSystemConfig.needsRewrite) {
      // Why: a migrated legacy state can still prove the last system content;
      // scrub legacy raw config without treating temporary absence as deletion.
      writeLastSyncedMirrorableSystemCodexConfigDigestValue(
        lastSyncedMirrorableSystemConfig.digest,
        lastSyncedMirrorableSystemConfig.unitDigests
      )
      return
    }
    const runtimeConfig = readFileSync(runtimeConfigPath, 'utf-8')
    const nextUnitDigests = getUnitDigestsAfterSystemConfigDeletion(
      runtimeConfig,
      lastSyncedMirrorableSystemConfig.unitDigests
    )
    const mergedConfig = mergeChangedSystemConfigUnitsIntoRuntime(
      runtimeConfig,
      systemConfigUnits,
      lastSyncedMirrorableSystemConfig.unitDigests
    )
    if (mergedConfig !== runtimeConfig) {
      writeFileAtomically(runtimeConfigPath, mergedConfig)
    }
    writeLastSyncedMirrorableSystemCodexConfigDigestValue(
      getSystemCodexConfigDigest(mirrorableSystemConfig),
      nextUnitDigests
    )
    return
  }

  if (lastSyncedMirrorableSystemConfig.status === 'missing') {
    // Why: pre-state runtime configs may already contain Codex TUI preference
    // changes written inside Orca's managed CODEX_HOME. Without a content
    // baseline, preserve those ordinary prefs and only sync trust state.
    const runtimeConfig = readFileSync(runtimeConfigPath, 'utf-8')
    const mergedConfig = mergeSystemProjectTrustIntoRuntimeBaseline(runtimeConfig, systemConfig)
    if (mergedConfig !== runtimeConfig) {
      writeFileAtomically(runtimeConfigPath, mergedConfig)
    }
    writeLastSyncedMirrorableSystemCodexConfigDigest(
      mirrorableSystemConfig,
      systemConfigUnitDigests
    )
    return
  }

  if (lastSyncedMirrorableSystemConfig.status === 'invalid') {
    const runtimeConfig = readFileSync(runtimeConfigPath, 'utf-8')
    const mergedConfig = mergeSystemProjectTrustIntoRuntimeBaseline(runtimeConfig, systemConfig)
    if (mergedConfig !== runtimeConfig) {
      writeFileAtomically(runtimeConfigPath, mergedConfig)
    }
    // Why: corrupt sync state cannot prove the ordinary system settings were
    // previously mirrored, so recover the baseline without overwriting TUI prefs.
    writeLastSyncedMirrorableSystemCodexConfigDigest(
      mirrorableSystemConfig,
      systemConfigUnitDigests
    )
    return
  }

  if (lastSyncedMirrorableSystemConfig.unitDigests === null) {
    const runtimeConfig = readFileSync(runtimeConfigPath, 'utf-8')
    const currentMirrorableSystemConfigDigest = getSystemCodexConfigDigest(mirrorableSystemConfig)
    const runtimeMirrorableConfigDigest = getSystemCodexConfigDigest(
      getMirrorableSystemCodexConfig(runtimeConfig)
    )
    if (lastSyncedMirrorableSystemConfig.digest === currentMirrorableSystemConfigDigest) {
      const mergedConfig = mergeSystemProjectTrustIntoRuntimeBaseline(runtimeConfig, systemConfig)
      if (mergedConfig !== runtimeConfig) {
        writeFileAtomically(runtimeConfigPath, mergedConfig)
      }
      writeLastSyncedMirrorableSystemCodexConfigDigest(
        mirrorableSystemConfig,
        systemConfigUnitDigests
      )
      return
    }
    if (lastSyncedMirrorableSystemConfig.digest === runtimeMirrorableConfigDigest) {
      const mergedConfig = mergeChangedSystemConfigUnitsIntoRuntime(
        runtimeConfig,
        systemConfigUnits,
        {}
      )
      if (mergedConfig !== runtimeConfig) {
        writeFileAtomically(runtimeConfigPath, mergedConfig)
      }
      writeLastSyncedMirrorableSystemCodexConfigDigest(
        mirrorableSystemConfig,
        systemConfigUnitDigests
      )
      return
    }
    const mergedConfig = mergeSystemProjectTrustIntoRuntimeBaseline(runtimeConfig, systemConfig)
    if (mergedConfig !== runtimeConfig) {
      writeFileAtomically(runtimeConfigPath, mergedConfig)
    }
    writeLastSyncedMirrorableSystemCodexConfigDigest(
      mirrorableSystemConfig,
      systemConfigUnitDigests
    )
    return
  }

  const runtimeConfig = readFileSync(runtimeConfigPath, 'utf-8')
  const mergedConfig = mergeChangedSystemConfigUnitsIntoRuntime(
    runtimeConfig,
    systemConfigUnits,
    lastSyncedMirrorableSystemConfig.unitDigests
  )
  if (mergedConfig !== runtimeConfig) {
    writeFileAtomically(runtimeConfigPath, mergedConfig)
  }
  writeLastSyncedMirrorableSystemCodexConfigDigest(mirrorableSystemConfig, systemConfigUnitDigests)
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
    const isHeader = line === undefined || /^[ \t]*\[[^\]]+\][ \t]*(?:#.*)?$/.test(line)
    if (!isHeader) {
      continue
    }

    if (featureStart !== null) {
      featureSections.push({ start: featureStart, end: index })
      featureStart = null
    }
    if (line !== undefined && /^[ \t]*\[features\][ \t]*(?:#.*)?$/.test(line)) {
      featureStart = index
    }
  }

  for (const section of featureSections.reverse()) {
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

  for (const index of deprecatedIndexes.reverse()) {
    lines.splice(index, 1)
  }
}

type SystemConfigUnit = {
  key: string
  stateKey: string
  digest: string
  block: string
  kind: 'ordinary' | 'project'
  placement: 'top-level' | 'section'
}

function getSystemConfigUnits(config: string): SystemConfigUnit[] {
  const ordinaryTopLevelUnits = getTopLevelTomlUnits(config).map((unit) =>
    createSystemConfigUnit(`top:${unit.key}`, unit.block, 'ordinary', 'top-level')
  )
  const sectionIdentityCounts = new Map<string, number>()
  const sectionUnits: SystemConfigUnit[] = []
  for (const section of getTomlSections(config)) {
    if (isRuntimeHookTrustTomlSection(section.header)) {
      continue
    }
    const identityKey = getTomlSectionIdentityKey(section.header)
    const occurrence = sectionIdentityCounts.get(identityKey) ?? 0
    sectionIdentityCounts.set(identityKey, occurrence + 1)
    sectionUnits.push(
      createSystemConfigUnit(
        `section:${identityKey}:${occurrence}`,
        section.block,
        isRuntimeProjectTomlSection(section.header) ? 'project' : 'ordinary',
        'section'
      )
    )
  }
  return [...ordinaryTopLevelUnits, ...sectionUnits]
}

function createSystemConfigUnit(
  key: string,
  block: string,
  kind: SystemConfigUnit['kind'],
  placement: SystemConfigUnit['placement']
): SystemConfigUnit {
  return {
    key,
    stateKey: getSystemCodexConfigDigest(key),
    digest: getSystemCodexConfigDigest(normalizeTomlUnitForDigest(block)),
    block,
    kind,
    placement
  }
}

function getSystemConfigUnitDigestRecord(units: SystemConfigUnit[]): Record<string, string> {
  return Object.fromEntries(units.map((unit) => [unit.stateKey, unit.digest]))
}

type TomlTopLevelUnit = {
  key: string
  block: string
}

function getTopLevelTomlUnits(config: string): TomlTopLevelUnit[] {
  const lines = config.split('\n')
  const firstSectionIndex = getTomlSections(config)[0]?.start ?? -1
  const topLevelLines = firstSectionIndex === -1 ? lines : lines.slice(0, firstSectionIndex)
  const units: TomlTopLevelUnit[] = []
  let unitStart = -1
  let unitKey: string | null = null
  let multilineState: TomlMultilineState = { basic: false, literal: false }

  for (let index = 0; index < topLevelLines.length; index += 1) {
    const line = topLevelLines[index] ?? ''
    const assignmentKey = isInsideTomlMultilineString(multilineState)
      ? null
      : getTomlAssignmentKey(line)
    if (assignmentKey !== null) {
      if (unitStart !== -1 && unitKey !== null) {
        units.push({
          key: unitKey,
          block: topLevelLines.slice(unitStart, index).join('\n')
        })
      }
      unitStart = index
      unitKey = assignmentKey
    }
    multilineState = updateTomlMultilineState(multilineState, line)
  }

  if (unitStart !== -1 && unitKey !== null) {
    units.push({
      key: unitKey,
      block: topLevelLines.slice(unitStart).join('\n')
    })
  }
  return units
}

function getTomlAssignmentKey(line: string): string | null {
  let mode: TomlMultilineMode = null
  let index = 0
  while (index < line.length) {
    if (mode === 'basic') {
      if (line[index] === '\\') {
        index += 2
        continue
      }
      if (line[index] === '"') {
        mode = null
      }
      index += 1
      continue
    }
    if (mode === 'literal') {
      if (line[index] === "'") {
        mode = null
      }
      index += 1
      continue
    }
    const char = line[index]
    if (char === '#') {
      return null
    }
    if (char === '=') {
      const key = line.slice(0, index).trim()
      return key.length > 0 ? key : null
    }
    if (char === '"') {
      mode = 'basic'
    } else if (char === "'") {
      mode = 'literal'
    }
    index += 1
  }
  return null
}

function normalizeTomlUnitForDigest(block: string): string {
  let multilineState: TomlMultilineState = { basic: false, literal: false }
  const lines: string[] = []
  for (const line of block.split('\n')) {
    const normalizedLine = isInsideTomlMultilineString(multilineState)
      ? line.trim()
      : normalizeTomlStructuralLineForDigest(line)
    if (normalizedLine.length > 0) {
      lines.push(normalizedLine)
    }
    multilineState = updateTomlMultilineState(multilineState, line)
  }
  return lines.join('\n')
}

function normalizeTomlStructuralLineForDigest(line: string): string {
  const header = getTomlTableHeader(line)
  const table = header ? parseTomlTableHeaderPath(header) : null
  if (table) {
    return getCanonicalTomlTableIdentity(table)
  }
  return stripTomlLineComment(line)
    .trim()
    .replace(/[ \t]*=[ \t]*/, ' = ')
}

function stripTomlLineComment(line: string): string {
  let mode: TomlMultilineMode = null
  let index = 0
  while (index < line.length) {
    if (mode === 'basic') {
      if (line[index] === '\\') {
        index += 2
        continue
      }
      if (line[index] === '"') {
        mode = null
      }
      index += 1
      continue
    }
    if (mode === 'literal') {
      if (line[index] === "'") {
        mode = null
      }
      index += 1
      continue
    }
    const char = line[index]
    if (char === '#') {
      return line.slice(0, index)
    }
    if (char === '"') {
      mode = 'basic'
    } else if (char === "'") {
      mode = 'literal'
    }
    index += 1
  }
  return line
}

function mergeChangedSystemConfigUnitsIntoRuntime(
  runtimeConfig: string,
  systemUnits: SystemConfigUnit[],
  previousUnitDigests: Record<string, string>
): string {
  const runtimeUnits = getSystemConfigUnits(runtimeConfig)
  const runtimeStateKeys = new Set(runtimeUnits.map((unit) => unit.stateKey))
  const systemStateKeys = new Set(systemUnits.map((unit) => unit.stateKey))
  const changedSystemStateKeys = new Set(
    systemUnits
      .filter(
        (unit) =>
          previousUnitDigests[unit.stateKey] !== unit.digest ||
          (unit.kind === 'project' && !runtimeStateKeys.has(unit.stateKey))
      )
      .map((unit) => unit.stateKey)
  )
  const removedSystemStateKeys = new Set(
    Object.keys(previousUnitDigests).filter((stateKey) => !systemStateKeys.has(stateKey))
  )
  const runtimeHookSections = getTomlSections(runtimeConfig)
    .filter((section) => isRuntimeHookTrustTomlSection(section.header))
    .map((section) => section.block)
  const changedSystemUnitByStateKey = new Map(
    systemUnits
      .filter((unit) => changedSystemStateKeys.has(unit.stateKey))
      .map((unit) => [
        unit.stateKey,
        unit.kind === 'project' ? getProjectUnitWithRuntimeOwnedFields(unit, runtimeUnits) : unit
      ])
  )
  const consumedChangedSystemStateKeys = new Set<string>()
  const outputUnits: SystemConfigUnit[] = []
  for (const runtimeUnit of runtimeUnits) {
    const changedSystemUnit = changedSystemUnitByStateKey.get(runtimeUnit.stateKey)
    if (changedSystemUnit) {
      outputUnits.push(changedSystemUnit)
      consumedChangedSystemStateKeys.add(runtimeUnit.stateKey)
      continue
    }
    const previousDigest = previousUnitDigests[runtimeUnit.stateKey]
    const shouldRemoveUnchangedSystemUnit =
      previousDigest !== undefined &&
      removedSystemStateKeys.has(runtimeUnit.stateKey) &&
      previousDigest === runtimeUnit.digest
    if (!shouldRemoveUnchangedSystemUnit) {
      outputUnits.push(runtimeUnit)
    }
  }
  outputUnits.push(
    ...[...changedSystemUnitByStateKey]
      .filter(([stateKey]) => !consumedChangedSystemStateKeys.has(stateKey))
      .map(([, unit]) => unit)
  )
  return joinTomlBlocks([
    ...outputUnits.filter((unit) => unit.placement === 'top-level').map((unit) => unit.block),
    ...outputUnits.filter((unit) => unit.placement === 'section').map((unit) => unit.block),
    ...runtimeHookSections
  ])
}

function getProjectUnitWithRuntimeOwnedFields(
  systemUnit: SystemConfigUnit,
  runtimeUnits: SystemConfigUnit[]
): SystemConfigUnit {
  const runtimeUnit = runtimeUnits.find((unit) => unit.stateKey === systemUnit.stateKey)
  if (!runtimeUnit) {
    return systemUnit
  }
  return {
    ...systemUnit,
    block: mergeProjectTrustAssignmentIntoRuntimeBlock(runtimeUnit.block, systemUnit.block)
  }
}

function mergeProjectTrustAssignmentIntoRuntimeBlock(
  runtimeBlock: string,
  systemBlock: string
): string {
  const systemTrustLine = getProjectTrustLine(systemBlock)
  if (!systemTrustLine) {
    return runtimeBlock
  }

  const lines = runtimeBlock.split('\n')
  const trustLineIndexes = lines
    .map((line, index) => (isProjectTrustAssignmentLine(line) ? index : -1))
    .filter((index) => index !== -1)
  if (trustLineIndexes.length === 0) {
    lines.splice(1, 0, systemTrustLine)
    return lines.join('\n')
  }

  lines[trustLineIndexes[0]!] = systemTrustLine
  for (const index of trustLineIndexes.slice(1).reverse()) {
    lines.splice(index, 1)
  }
  return lines.join('\n')
}

function getProjectTrustLine(block: string): string | null {
  return block.split('\n').find((line) => isProjectTrustAssignmentLine(line)) ?? null
}

function isProjectTrustAssignmentLine(line: string): boolean {
  return /^[ \t]*trust_level[ \t]*=/.test(line) && getProjectTrustLevel(`x = 1\n${line}\n`) !== null
}

function getUnitDigestsAfterSystemConfigDeletion(
  runtimeConfig: string,
  previousUnitDigests: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    getSystemConfigUnits(runtimeConfig)
      .map((unit) => [unit.stateKey, previousUnitDigests[unit.stateKey], unit.digest] as const)
      .filter(
        ([, previousDigest, runtimeDigest]) =>
          previousDigest !== undefined && previousDigest !== runtimeDigest
      )
      .map(([stateKey, previousDigest]) => [stateKey, previousDigest])
  )
}

function getMirrorableSystemCodexConfig(systemConfig: string): string {
  return joinTomlBlocks(
    getSystemConfigUnits(systemConfig)
      .filter((unit) => unit.kind === 'ordinary')
      .map((unit) => unit.block)
  )
}

function mergeSystemProjectTrustIntoRuntimeBaseline(
  runtimeConfig: string,
  systemConfig: string
): string {
  const runtimeSections = getTomlSections(runtimeConfig)
  const runtimeProjectHeaders = new Set(
    runtimeSections
      .filter((section) => isRuntimeProjectTomlSection(section.header))
      .map((section) => getTomlSectionIdentityKey(section.header))
  )
  const systemProjectSections = getTomlSections(systemConfig).filter((section) =>
    isRuntimeProjectTomlSection(section.header)
  )
  const systemProjectSectionsByHeader = new Map(
    systemProjectSections.map((section) => [getTomlSectionIdentityKey(section.header), section])
  )
  const systemProjectSectionsToAppend = systemProjectSections.filter(
    (section) => !runtimeProjectHeaders.has(getTomlSectionIdentityKey(section.header))
  )
  const hasExplicitTrustToMerge = systemProjectSections.some(
    (section) =>
      runtimeProjectHeaders.has(getTomlSectionIdentityKey(section.header)) &&
      getProjectTrustLevel(section.block) !== null
  )
  if (systemProjectSectionsToAppend.length === 0 && !hasExplicitTrustToMerge) {
    return runtimeConfig
  }

  const systemExplicitTrustProjectHeaders = new Set(
    systemProjectSections
      .filter((section) => getProjectTrustLevel(section.block) !== null)
      .map((section) => getTomlSectionIdentityKey(section.header))
  )
  const lines = runtimeConfig.split('\n')
  const firstSectionIndex = runtimeSections[0]?.start ?? -1
  const preamble =
    firstSectionIndex === -1 ? runtimeConfig : lines.slice(0, firstSectionIndex).join('\n')
  // Why: when the baseline is missing, Orca cannot safely decide whether
  // ordinary settings changed in system or runtime config. Project trust is
  // safety-sensitive, so still honor explicit system revocations.
  return joinTomlBlocks([
    preamble,
    ...runtimeSections.map((section) => {
      const identityKey = getTomlSectionIdentityKey(section.header)
      if (
        !isRuntimeProjectTomlSection(section.header) ||
        !systemExplicitTrustProjectHeaders.has(identityKey)
      ) {
        return section.block
      }
      const systemSection = systemProjectSectionsByHeader.get(identityKey)
      return systemSection
        ? mergeProjectTrustAssignmentIntoRuntimeBlock(section.block, systemSection.block)
        : section.block
    }),
    ...systemProjectSectionsToAppend.map((section) => section.block)
  ])
}

type TomlSection = {
  header: string
  block: string
  start: number
}

type TomlMultilineState = {
  basic: boolean
  literal: boolean
}

type TomlMultilineMode = 'basic' | 'literal' | null

function stripRuntimeOwnedTomlSections(
  config: string,
  runtimeProjectHeaders = new Set<string>()
): string {
  const lines = config.split('\n')
  const sections = getTomlSections(config)
  const firstSectionIndex = sections[0]?.start ?? -1
  const preamble = firstSectionIndex === -1 ? config : lines.slice(0, firstSectionIndex).join('\n')
  return joinTomlBlocks([
    preamble,
    ...sections
      .filter((section) => !isRuntimeHookTrustTomlSection(section.header))
      .filter(
        (section) =>
          !isRuntimeProjectTomlSection(section.header) ||
          !runtimeProjectHeaders.has(getTomlSectionIdentityKey(section.header)) ||
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
  let multilineState: TomlMultilineState = { basic: false, literal: false }

  for (let index = 0; index < lines.length; index += 1) {
    const header = isInsideTomlMultilineString(multilineState)
      ? null
      : getTomlTableHeader(lines[index] ?? '')
    if (!header) {
      multilineState = updateTomlMultilineState(multilineState, lines[index] ?? '')
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
    multilineState = updateTomlMultilineState(multilineState, lines[index] ?? '')
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

function isRuntimeHookTrustTomlSection(header: string): boolean {
  const table = parseTomlTableHeaderPath(header)
  return table?.parts[0] === 'hooks' && table.parts[1] === 'state' && table.parts.length > 2
}

function isRuntimeProjectTomlSection(header: string): boolean {
  const table = parseTomlTableHeaderPath(header)
  return table?.parts[0] === 'projects' && table.parts.length > 1
}

function getTomlSectionIdentityKey(header: string): string {
  const table = parseTomlTableHeaderPath(header)
  if (!table) {
    return header.trim()
  }
  return getCanonicalTomlTableIdentity(table)
}

function getCanonicalTomlTableIdentity(table: { array: boolean; parts: string[] }): string {
  if (table.parts[0] === 'projects' && table.parts.length > 1) {
    return `project:${normalizeRuntimePathForComparison(table.parts.slice(1).join('.'))}`
  }
  return JSON.stringify({ array: table.array, parts: table.parts })
}

function parseTomlTableHeaderPath(header: string): { array: boolean; parts: string[] } | null {
  const trimmed = header.trim()
  const arrayMatch = /^\[\[\s*(.*?)\s*\]\]$/.exec(trimmed)
  const tableMatch = /^\[\s*(.*?)\s*\]$/.exec(trimmed)
  const keyPath = arrayMatch?.[1] ?? tableMatch?.[1]
  if (keyPath === undefined) {
    return null
  }
  const parts = splitTomlDottedKeyPath(keyPath)
    .map((part) => parseTomlHeaderKeyPart(part.trim()))
    .filter((part): part is string => part !== null)
  return parts.length > 0 ? { array: arrayMatch !== null, parts } : null
}

function splitTomlDottedKeyPath(keyPath: string): string[] {
  const parts: string[] = []
  let mode: TomlMultilineMode = null
  let partStart = 0
  let index = 0
  while (index < keyPath.length) {
    if (mode === 'basic') {
      if (keyPath[index] === '\\') {
        index += 2
        continue
      }
      if (keyPath[index] === '"') {
        mode = null
      }
      index += 1
      continue
    }
    if (mode === 'literal') {
      if (keyPath[index] === "'") {
        mode = null
      }
      index += 1
      continue
    }
    if (keyPath[index] === '"') {
      mode = 'basic'
    } else if (keyPath[index] === "'") {
      mode = 'literal'
    } else if (keyPath[index] === '.') {
      parts.push(keyPath.slice(partStart, index))
      partStart = index + 1
    }
    index += 1
  }
  parts.push(keyPath.slice(partStart))
  return parts
}

function parseTomlHeaderKeyPart(keyPart: string): string | null {
  if (keyPart.startsWith('"') && keyPart.endsWith('"')) {
    return parseTomlBasicStringValue(keyPart)
  }
  if (keyPart.startsWith("'") && keyPart.endsWith("'")) {
    return keyPart.slice(1, -1)
  }
  return keyPart.length > 0 ? keyPart : null
}

function parseTomlBasicStringValue(value: string): string | null {
  try {
    return JSON.parse(value) as string
  } catch {
    return null
  }
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

function getTomlTableHeader(line: string): string | null {
  const match = /^(\s*\[\[?.+\]\]?\s*)(?:#.*)?$/.exec(line)
  return match?.[1] ?? null
}

function isInsideTomlMultilineString(state: TomlMultilineState): boolean {
  return state.basic || state.literal
}

function updateTomlMultilineState(state: TomlMultilineState, line: string): TomlMultilineState {
  let mode: TomlMultilineMode = state.basic ? 'basic' : state.literal ? 'literal' : null
  let index = 0
  while (index < line.length) {
    if (mode === 'basic') {
      if (line[index] === '\\') {
        index += 2
        continue
      }
      if (line.startsWith('"""', index)) {
        mode = null
        index += 3
        continue
      }
      index += 1
      continue
    }
    if (mode === 'literal') {
      if (line.startsWith("'''", index)) {
        mode = null
        index += 3
        continue
      }
      index += 1
      continue
    }

    const char = line[index]
    if (char === '#') {
      break
    }
    if (line.startsWith('"""', index)) {
      mode = 'basic'
      index += 3
      continue
    }
    if (line.startsWith("'''", index)) {
      mode = 'literal'
      index += 3
      continue
    }
    if (char === '"') {
      index = skipTomlBasicString(line, index + 1)
      continue
    }
    if (char === "'") {
      index = skipTomlLiteralString(line, index + 1)
      continue
    }
    index += 1
  }
  return { basic: mode === 'basic', literal: mode === 'literal' }
}

function skipTomlBasicString(line: string, startIndex: number): number {
  let index = startIndex
  while (index < line.length) {
    const char = line[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '"') {
      return index + 1
    }
    index += 1
  }
  return index
}

function skipTomlLiteralString(line: string, startIndex: number): number {
  const endIndex = line.indexOf("'", startIndex)
  return endIndex === -1 ? line.length : endIndex + 1
}
