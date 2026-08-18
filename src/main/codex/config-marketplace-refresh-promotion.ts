import {
  createTomlLineScanState,
  isTomlStructuralLine,
  parseTomlSingleLineStringValue,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'
import {
  extractOrdinaryCodexSettings,
  getTomlSections,
  joinTomlBlocks,
  type TomlSection
} from './config-toml-runtime-owned-sections'
import { upsertPromotedSettingsInContent } from './codex-config-settings-upsert'

type MarketplaceField = {
  lineIndex: number
  stringValue: { value: string; rawValue: string } | null
  stringArrayValue: string[] | null
  leadingWhitespace: string
  trailingText: string
  lineEnding: string
}

type MarketplaceTable = {
  name: string
  fields: ReadonlyMap<string, MarketplaceField>
}

const MARKETPLACE_IDENTITY_KEYS = ['source_type', 'source', 'ref', 'sparse_paths'] as const

export function prepareSystemConfigForPromotion(
  systemConfig: string | null,
  runtimeConfig: string,
  updates: Map<string, string>
): string | null {
  if (systemConfig === null && updates.size === 0) {
    return null
  }
  const ordinaryConfig =
    systemConfig ?? stripMarketplaceTomlSections(extractOrdinaryCodexSettings(runtimeConfig))
  const configWithRefresh =
    systemConfig === null
      ? ordinaryConfig
      : promoteMarketplaceRefreshMetadata(ordinaryConfig, runtimeConfig)
  return upsertPromotedSettingsInContent(configWithRefresh, updates)
}

/**
 * Promotes Codex-owned refresh metadata from a managed home into the canonical
 * config only when the canonical marketplace still describes the same source.
 */
export function promoteMarketplaceRefreshMetadata(
  systemConfig: string,
  runtimeConfig: string
): string {
  const systemTables = getMarketplaceTables(systemConfig)
  const runtimeTables = getMarketplaceTables(runtimeConfig)
  const lines = systemConfig.split('\n')
  let changed = false

  const matchingTables = [...systemTables.values()]
    .map((systemTable) => ({
      systemTable,
      runtimeTable: runtimeTables.get(systemTable.name)
    }))
    .filter(
      (
        candidate
      ): candidate is {
        systemTable: MarketplaceTable
        runtimeTable: MarketplaceTable
      } => candidate.runtimeTable !== undefined
    )
    .filter(({ systemTable, runtimeTable }) =>
      marketplaceIdentityMatches(systemTable, runtimeTable)
    )
    .filter(({ systemTable, runtimeTable }) =>
      marketplaceTimestampIsNewer(systemTable, runtimeTable)
    )
    .sort((left, right) => getTableStart(right.systemTable) - getTableStart(left.systemTable))

  for (const { systemTable, runtimeTable } of matchingTables) {
    const systemTimestamp = systemTable.fields.get('last_updated')
    const runtimeTimestamp = runtimeTable.fields.get('last_updated')
    if (!systemTimestamp || !runtimeTimestamp || !runtimeTimestamp.stringValue) {
      continue
    }
    lines[systemTimestamp.lineIndex] = replaceFieldValue(
      lines[systemTimestamp.lineIndex] ?? '',
      systemTimestamp,
      runtimeTimestamp.stringValue.rawValue
    )
    const runtimeRevision = runtimeTable.fields.get('last_revision')
    if (runtimeRevision?.stringValue) {
      const systemRevision = systemTable.fields.get('last_revision')
      if (systemRevision) {
        lines[systemRevision.lineIndex] = replaceFieldValue(
          lines[systemRevision.lineIndex] ?? '',
          systemRevision,
          runtimeRevision.stringValue.rawValue
        )
      } else {
        const line = lines[systemTimestamp.lineIndex] ?? ''
        const indentation = /^\s*/.exec(line)?.[0] ?? ''
        lines.splice(
          systemTimestamp.lineIndex + 1,
          0,
          `${indentation}last_revision = ${runtimeRevision.stringValue.rawValue}${
            systemTimestamp.lineEnding
          }`
        )
      }
    }
    changed = true
  }

  return changed ? lines.join('\n') : systemConfig
}

/** Removes runtime-only marketplace tables before seeding a new canonical config. */
export function stripMarketplaceTomlSections(config: string): string {
  const sections = getTomlSections(config)
  const firstSectionIndex = sections[0]?.start ?? -1
  const lines = config.split('\n')
  const preamble = firstSectionIndex === -1 ? config : lines.slice(0, firstSectionIndex).join('\n')
  return joinTomlBlocks([
    preamble,
    ...sections.filter((section) => !isMarketplaceSection(section)).map((section) => section.block)
  ])
}

function getMarketplaceTables(config: string): Map<string, MarketplaceTable> {
  const tables = new Map<string, MarketplaceTable>()
  for (const section of getTomlSections(config)) {
    const header = parseTomlTableHeaderPath(section.header)
    if (
      !header ||
      header.isArray ||
      header.segments.length !== 2 ||
      header.segments[0] !== 'marketplaces'
    ) {
      continue
    }
    tables.set(header.segments[1]!, {
      name: header.segments[1]!,
      fields: getMarketplaceFields(section)
    })
  }
  return tables
}

function getMarketplaceFields(section: TomlSection): Map<string, MarketplaceField> {
  const fields = new Map<string, MarketplaceField>()
  const lines = section.block.split('\n')
  let scanState = createTomlLineScanState()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (isTomlStructuralLine(scanState)) {
      const parsed = parseTomlKeyPath(line)
      const key = parsed?.segments.length === 1 ? parsed.segments[0] : null
      if (parsed && key && line[parsed.end] === '=' && isMarketplaceField(key)) {
        const valueArea = line.slice(parsed.end + 1)
        const trimmedValueArea = valueArea.trim()
        const stringValue = parseStringValue(trimmedValueArea)
        const stringArrayValue = parseStringArrayValue(trimmedValueArea)
        const valueEnd = stringValue ? stringValue.end : stringArrayValue ? stringArrayValue.end : 0
        const leadingWhitespace = valueArea.slice(
          0,
          valueArea.length - valueArea.trimStart().length
        )
        const lineEnding = line.endsWith('\r') ? '\r' : ''
        fields.set(key, {
          lineIndex: section.start + index,
          stringValue: stringValue
            ? { value: stringValue.value, rawValue: trimmedValueArea.slice(0, stringValue.end) }
            : null,
          stringArrayValue: stringArrayValue?.value ?? null,
          leadingWhitespace,
          trailingText: trimmedValueArea.slice(valueEnd),
          lineEnding
        })
      }
    }
    scanState = updateTomlLineScanState(scanState, line)
  }
  return fields
}

function isMarketplaceField(key: string): boolean {
  return (
    key === 'last_updated' ||
    key === 'last_revision' ||
    (MARKETPLACE_IDENTITY_KEYS as readonly string[]).includes(key)
  )
}

function marketplaceIdentityMatches(
  systemTable: MarketplaceTable,
  runtimeTable: MarketplaceTable
): boolean {
  for (const key of ['source_type', 'source'] as const) {
    const systemField = systemTable.fields.get(key)
    const runtimeField = runtimeTable.fields.get(key)
    if (!systemField || !runtimeField) {
      return false
    }
    if (
      systemField.stringValue === null ||
      runtimeField.stringValue === null ||
      systemField.stringValue.value !== runtimeField.stringValue.value
    ) {
      return false
    }
  }
  for (const key of ['ref', 'sparse_paths'] as const) {
    const systemField = systemTable.fields.get(key)
    const runtimeField = runtimeTable.fields.get(key)
    if (!systemField && !runtimeField) {
      continue
    }
    if (!systemField || !runtimeField) {
      return false
    }
    if (key === 'sparse_paths') {
      // Why: an unparsed array (multi-line) can't prove identity, so fail closed rather than promote across a source change.
      if (
        systemField.stringArrayValue === null ||
        runtimeField.stringArrayValue === null ||
        !arraysEqual(systemField.stringArrayValue, runtimeField.stringArrayValue)
      ) {
        return false
      }
      continue
    }
    if (systemField.stringValue === null || runtimeField.stringValue === null) {
      return false
    }
    if (systemField.stringValue.value !== runtimeField.stringValue.value) {
      return false
    }
  }
  return true
}

function marketplaceTimestampIsNewer(
  systemTable: MarketplaceTable,
  runtimeTable: MarketplaceTable
): boolean {
  const systemTimestamp = systemTable.fields.get('last_updated')?.stringValue?.value
  const runtimeTimestamp = runtimeTable.fields.get('last_updated')?.stringValue?.value
  if (!systemTimestamp || !runtimeTimestamp) {
    return false
  }
  const systemTime = Date.parse(systemTimestamp)
  const runtimeTime = Date.parse(runtimeTimestamp)
  return Number.isFinite(systemTime) && Number.isFinite(runtimeTime) && runtimeTime > systemTime
}

function replaceFieldValue(line: string, field: MarketplaceField, rawValue: string): string {
  return `${line.slice(0, line.indexOf('=') + 1)}${field.leadingWhitespace}${rawValue}${field.trailingText}${field.lineEnding}`
}

function isMarketplaceSection(section: TomlSection): boolean {
  const header = parseTomlTableHeaderPath(section.header)
  return Boolean(
    header &&
    !header.isArray &&
    header.segments.length === 2 &&
    header.segments[0] === 'marketplaces'
  )
}

function getTableStart(table: MarketplaceTable): number {
  return table.fields.values().next().value?.lineIndex ?? -1
}

function parseStringValue(raw: string): { value: string; end: number } | null {
  const parsed = parseTomlSingleLineStringValue(raw, 0)
  if (!parsed || !isTomlCommentOrWhitespace(raw.slice(parsed.end))) {
    return null
  }
  return parsed
}

function parseStringArrayValue(raw: string): { value: string[]; end: number } | null {
  if (!raw.startsWith('[')) {
    return null
  }
  const values: string[] = []
  let index = 1
  while (index < raw.length) {
    while (raw[index] === ' ' || raw[index] === '\t') {
      index += 1
    }
    if (raw[index] === ']') {
      return { value: values, end: index + 1 }
    }
    const parsed = parseTomlSingleLineStringValue(raw, index)
    if (!parsed) {
      return null
    }
    values.push(parsed.value)
    index = parsed.end
    while (raw[index] === ' ' || raw[index] === '\t') {
      index += 1
    }
    if (raw[index] === ',') {
      index += 1
      continue
    }
    if (raw[index] === ']') {
      return { value: values, end: index + 1 }
    }
    return null
  }
  return null
}

function isTomlCommentOrWhitespace(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
