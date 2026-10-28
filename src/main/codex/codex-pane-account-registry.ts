import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { dirname, join } from 'node:path'
import { getOrcaUserDataPath } from './codex-home-paths'
import { CodexPaneAccountRegistryMutations } from './codex-pane-account-registry-mutations'
import type {
  CodexPaneAccountRecord,
  CodexPaneAccountRegistryFile,
  CodexPaneHomeRoute
} from './codex-pane-account-registry-types'

export type {
  CodexPaneAccountRecord,
  CodexPaneHomeRoute
} from './codex-pane-account-registry-types'

// Daemon PTYs retain spawn-time CODEX_HOME across app restarts; persist attribution for restart prompts.

let cachedRegistry: CodexPaneAccountRegistryFile | null = null
let cachedRegistryIsAuthoritative = true

function getRegistryPath(): string {
  return join(getOrcaUserDataPath(), 'codex-pane-accounts.json')
}

// Return uncached null on read errors; treating unreadable state as empty would erase attribution.
function readRegistryOrNull(): CodexPaneAccountRegistryFile | null {
  if (cachedRegistry) {
    return cachedRegistry
  }
  let rawRegistry: string
  try {
    rawRegistry = readFileSync(getRegistryPath(), 'utf-8')
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      return null
    }
    cachedRegistry = parseRegistry(null)
    return cachedRegistry
  }
  // Cache salvaged/corrupt parse results; rereading unchanged bytes cannot recover more state.
  const parsedRegistry = parseRegistryJson(rawRegistry)
  cachedRegistryIsAuthoritative = isAuthoritativeRegistry(parsedRegistry)
  cachedRegistry = parseRegistry(parsedRegistry)
  if (!cachedRegistryIsAuthoritative) {
    cachedRegistry.legacyWslAttributionUnknown = true
  }
  return cachedRegistry
}

function parseRegistryJson(rawRegistry: string): unknown {
  try {
    return JSON.parse(rawRegistry)
  } catch {
    return null
  }
}

// Callers may read pending mutations while the disk registry is unavailable.
function readRegistry(): CodexPaneAccountRegistryFile {
  mutations.flush()
  if (!cachedRegistry) {
    const pendingRegistry = mutations.getPendingRegistry()
    if (pendingRegistry) {
      return pendingRegistry
    }
  }
  return readRegistryOrNull() ?? { version: 2, panes: {} }
}

function readRegistryOrThrow(): CodexPaneAccountRegistryFile {
  mutations.flush()
  const registry = readRegistryOrNull()
  if (!registry || !cachedRegistryIsAuthoritative) {
    throw new Error('Codex pane account registry could not be read')
  }
  return registry
}

function isAuthoritativeRegistry(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false
  }
  const panes = (parsed as Partial<CodexPaneAccountRegistryFile>).panes
  const version = (parsed as Partial<CodexPaneAccountRegistryFile>).version
  const legacyWslAttributionUnknown = (parsed as Partial<CodexPaneAccountRegistryFile>)
    .legacyWslAttributionUnknown
  return (
    version === 2 &&
    Boolean(panes) &&
    typeof panes === 'object' &&
    !Array.isArray(panes) &&
    Object.values(panes).every(isPaneAccountRecord) &&
    (legacyWslAttributionUnknown === undefined || legacyWslAttributionUnknown === true)
  )
}

function parseRegistry(parsed: unknown): CodexPaneAccountRegistryFile {
  const empty: CodexPaneAccountRegistryFile = { version: 2, panes: {} }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return empty
  }
  const panes = (parsed as Partial<CodexPaneAccountRegistryFile>).panes
  if (!panes || typeof panes !== 'object' || Array.isArray(panes)) {
    return empty
  }
  if ((parsed as Partial<CodexPaneAccountRegistryFile>).legacyWslAttributionUnknown === true) {
    empty.legacyWslAttributionUnknown = true
  }
  for (const [ptyId, record] of Object.entries(panes)) {
    if (isPaneAccountRecord(record)) {
      const homeRoute = readPaneHomeRoute(record.homeRoute)
      empty.panes[ptyId] = {
        selectionKey: record.selectionKey,
        accountId: record.accountId,
        ...(homeRoute ? { homeRoute } : {})
      }
    }
  }
  return empty
}

function isPaneAccountRecord(value: unknown): value is CodexPaneAccountRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as Partial<CodexPaneAccountRecord>
  return (
    (record.selectionKey === 'host' ||
      (typeof record.selectionKey === 'string' && /^wsl:.+/.test(record.selectionKey))) &&
    (record.accountId === null || typeof record.accountId === 'string')
  )
}

// Older builds called shared-home panes with pane-local CODEX_HOME 'custom-home'.
function readPaneHomeRoute(value: unknown): CodexPaneHomeRoute | undefined {
  if (value === 'custom-home') {
    return 'shared-home'
  }
  return value === 'real-home' ||
    value === 'shared-home' ||
    value === 'account-home' ||
    value === 'wsl-home'
    ? value
    : undefined
}

function writeRegistry(registry: CodexPaneAccountRegistryFile): boolean {
  const registryPath = getRegistryPath()
  const temporaryPath = `${registryPath}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(registryPath), { recursive: true })
    writeFileSync(temporaryPath, `${JSON.stringify(registry)}\n`, {
      encoding: 'utf-8',
      mode: 0o600
    })
    renameSync(temporaryPath, registryPath)
    cachedRegistryIsAuthoritative = true
    return true
  } catch (error) {
    // Restart-hint persistence failures must not break PTY spawn/teardown, including cleanup failures.
    console.warn('[codex-pane-accounts] Failed to persist pane account registry:', error)
    try {
      rmSync(temporaryPath, { force: true })
    } catch {}
    return false
  }
}

const mutations = new CodexPaneAccountRegistryMutations({
  read: readRegistryOrNull,
  write: writeRegistry
})

export function recordCodexPaneAccount(ptyId: string, record: CodexPaneAccountRecord | null): void {
  // Retain one-shot spawn attribution during read failures, then merge it into recovered state.
  mutations.record(ptyId, record)
}

export function forgetCodexPaneAccount(ptyId: string): void {
  recordCodexPaneAccount(ptyId, null)
}

export function getCodexPaneAccount(ptyId: string): CodexPaneAccountRecord | null {
  return readRegistry().panes[ptyId] ?? null
}

export function isCodexPaneHomeRouteProvenAwayFromSharedHome(
  route: CodexPaneHomeRoute | undefined
): boolean {
  return route === 'real-home' || route === 'account-home' || route === 'wsl-home'
}

// Use actual spawn lanes for account-switch prompts; edited settings no longer describe retained panes.
export function listRecordedCodexPaneLanes(ptyIds: readonly string[]): Record<string, string> {
  const registry = readRegistryOrThrow()
  const lanesByPtyId: Record<string, string> = {}
  for (const ptyId of ptyIds) {
    const record = registry.panes[ptyId]
    if (record) {
      lanesByPtyId[ptyId] = record.selectionKey
    }
  }
  return lanesByPtyId
}

/** Restart decisions require authoritative attribution, not an unavailable-file fallback. */
export function listRecordedCodexPaneAccounts(
  ptyIds: readonly string[]
): ReadonlyMap<string, CodexPaneAccountRecord> {
  const registry = readRegistryOrThrow()
  const records = new Map<string, CodexPaneAccountRecord>()
  for (const ptyId of ptyIds) {
    const record = registry.panes[ptyId]
    if (record) {
      records.set(ptyId, record)
    }
  }
  return records
}

export function hasRecordedLegacySharedCodexPane(): boolean {
  return Object.values(readRegistry().panes).some(
    (record) =>
      record.selectionKey === 'host' &&
      (record.homeRoute === undefined || record.homeRoute === 'shared-home')
  )
}

export function hasRecordedLegacyWslCodexPane(selectionKey: string): boolean {
  const registry = readRegistryOrThrow()
  return (
    Boolean(registry.legacyWslAttributionUnknown) ||
    Object.values(registry.panes).some(
      (record) =>
        (wslSelectionKeysMatch(record.selectionKey, selectionKey) ||
          record.selectionKey === 'wsl:__default__') &&
        (record.homeRoute === undefined || record.homeRoute === 'wsl-home')
    )
  )
}

function wslSelectionKeysMatch(left: string, right: string): boolean {
  return (
    left.startsWith('wsl:') &&
    right.startsWith('wsl:') &&
    left.slice('wsl:'.length).toLowerCase() === right.slice('wsl:'.length).toLowerCase()
  )
}

export function hasAnyRecordedLegacyWslCodexPane(): boolean {
  const registry = readRegistry()
  return (
    Boolean(registry.legacyWslAttributionUnknown) ||
    Object.values(registry.panes).some(
      (record) =>
        record.selectionKey.startsWith('wsl:') &&
        (record.homeRoute === undefined || record.homeRoute === 'wsl-home')
    )
  )
}

export function hasRecordedManagedHostCodexPane(): boolean {
  return Object.values(readRegistry().panes).some(
    (record) =>
      record.selectionKey === 'host' &&
      (record.homeRoute === undefined ||
        record.homeRoute === 'shared-home' ||
        (record.homeRoute === 'account-home' && record.accountId !== null))
  )
}

/** livePtyIds must be authoritative daemon inventory. */
export function reconcileCodexPaneAccountsWithLivePtys(livePtyIds: readonly string[]): void {
  // Never persist an empty stand-in over a registry we could not read.
  mutations.flush()
  const registry = readRegistryOrNull()
  if (!registry) {
    return
  }
  const livePtyIdSet = new Set(livePtyIds)
  let changed = false
  if (
    registry.legacyWslAttributionUnknown &&
    livePtyIds.every((ptyId) => ptyId in registry.panes)
  ) {
    delete registry.legacyWslAttributionUnknown
    changed = true
  }
  for (const ptyId of Object.keys(registry.panes)) {
    if (!livePtyIdSet.has(ptyId)) {
      delete registry.panes[ptyId]
      changed = true
    }
  }
  mutations.persistReconciliation(registry, changed)
}

export const _internals = {
  resetCache: (): void => {
    cachedRegistry = null
    cachedRegistryIsAuthoritative = true
    mutations.reset()
  }
}
