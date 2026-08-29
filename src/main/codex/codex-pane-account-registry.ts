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
import type {
  CodexEnvironmentHomeOverride,
  CodexShellStartupHomeOverride
} from './codex-real-home-path'

export type {
  CodexPaneAccountRecord,
  CodexPaneHomeRoute
} from './codex-pane-account-registry-types'

/**
 * Remembers which Codex account each live PTY was launched under.
 *
 * Why: `CODEX_HOME` is baked into a PTY's environment at spawn and can never be
 * changed afterwards, so a shell keeps launching Codex against the account that
 * was selected when the terminal opened. The daemon keeps those shells alive
 * across app restarts, so without an on-disk record Orca forgets a pane is on
 * the old account and the user is stuck there with no prompt to escape it.
 */

let cachedRegistry: CodexPaneAccountRegistryFile | null = null

function getRegistryPath(): string {
  return join(getOrcaUserDataPath(), 'codex-pane-accounts.json')
}

/**
 * `null` means the registry could not be READ. That is not the same as "no
 * panes are attributed", and it must never be cached: the old `catch { return
 * null }` collapsed both into an empty registry, so one unreadable read erased
 * every pane's account attribution AND pinned that erasure in `cachedRegistry`
 * for the rest of the process, surviving the file becoming readable again.
 */
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
  // Why: a corrupt registry still degrades to empty and IS cached — rebuilding
  // unparseable state is the intent, and re-reading it every call would only
  // repeat the parse failure.
  cachedRegistry = parseRegistry(parseRegistryJson(rawRegistry))
  return cachedRegistry
}

function parseRegistryJson(rawRegistry: string): unknown {
  try {
    return JSON.parse(rawRegistry)
  } catch {
    return null
  }
}

/** Read-only callers: an unreadable registry reports no attribution, uncached. */
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
  if (!registry) {
    throw new Error('Codex pane account registry could not be read')
  }
  return registry
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
  for (const [ptyId, record] of Object.entries(panes)) {
    if (isPaneAccountRecord(record)) {
      empty.panes[ptyId] = {
        selectionKey: record.selectionKey,
        accountId: record.accountId,
        ...(isPaneHomeRoute(record.homeRoute) ? { homeRoute: record.homeRoute } : {}),
        ...(isShellStartupHomeOverride(record.shellStartupHomeOverride)
          ? { shellStartupHomeOverride: record.shellStartupHomeOverride }
          : {}),
        ...(isEnvironmentHomeOverride(record.environmentHomeOverride)
          ? { environmentHomeOverride: record.environmentHomeOverride }
          : {})
      }
    }
  }
  return empty
}

function isEnvironmentHomeOverride(value: unknown): value is CodexEnvironmentHomeOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const context = value as Partial<CodexEnvironmentHomeOverride>
  return typeof context.codexHome === 'string' && context.codexHome.length > 0
}

function isShellStartupHomeOverride(value: unknown): value is CodexShellStartupHomeOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const context = value as Partial<CodexShellStartupHomeOverride>
  return (
    typeof context.home === 'string' &&
    context.home.length > 0 &&
    (context.shell === undefined || typeof context.shell === 'string') &&
    (context.configHome === undefined || typeof context.configHome === 'string') &&
    typeof context.codexHome === 'string' &&
    context.codexHome.length > 0
  )
}

function isPaneAccountRecord(value: unknown): value is CodexPaneAccountRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as Partial<CodexPaneAccountRecord>
  return (
    typeof record.selectionKey === 'string' &&
    (record.accountId === null || typeof record.accountId === 'string')
  )
}

function isPaneHomeRoute(value: unknown): value is CodexPaneHomeRoute {
  return (
    value === 'real-home' ||
    value === 'shared-home' ||
    value === 'account-home' ||
    value === 'custom-home' ||
    value === 'wsl-home'
  )
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
    return true
  } catch (error) {
    // Why: this record only powers a restart hint; losing it must never break a
    // terminal spawn or a PTY teardown — including when the cleanup itself fails.
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

/**
 * Records the account a PTY launched under. Pass null to forget a pinned pane.
 */
export function recordCodexPaneAccount(ptyId: string, record: CodexPaneAccountRecord | null): void {
  // Why: the spawn attribution is one-shot. Retain it while the registry is
  // unreadable, then merge it with the recovered file instead of dropping it
  // or rebuilding from an empty stand-in.
  mutations.record(ptyId, record)
}

/**
 * Drops a PTY's record once it exits.
 */
export function forgetCodexPaneAccount(ptyId: string): void {
  recordCodexPaneAccount(ptyId, null)
}

/**
 * Returns the account a PTY launched under, or null when it was never recorded.
 */
export function getCodexPaneAccount(ptyId: string): CodexPaneAccountRecord | null {
  return readRegistry().panes[ptyId] ?? null
}

/** `custom-home` stays conservative because it can mask a non-comparable shared-home route. */
export function isCodexPaneHomeRouteProvenAwayFromSharedHome(
  route: CodexPaneHomeRoute | undefined
): boolean {
  return route === 'real-home' || route === 'account-home' || route === 'wsl-home'
}

/**
 * Reports the lane each given PTY launched from, omitting panes with no record.
 *
 * Why the renderer needs this: an account switch has to know which panes the
 * change could have stranded, and this key was written from the shell, cwd and
 * distro the spawn actually resolved. Re-deriving it from current settings
 * answers for a launch that never happened once the user edits those settings.
 */
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

/** Reads restart-authoritative records without mapping an unavailable file to no attribution. */
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

/** True when a retained host pane may still read the retired shared CODEX_HOME. */
export function hasRecordedLegacySharedCodexPane(): boolean {
  return Object.values(readRegistry().panes).some(
    (record) =>
      record.selectionKey === 'host' &&
      (record.homeRoute === undefined ||
        record.homeRoute === 'shared-home' ||
        record.homeRoute === 'custom-home')
  )
}

/** True when startup may need to repair hooks for a retained managed host pane. */
export function hasRecordedManagedHostCodexPane(): boolean {
  return Object.values(readRegistry().panes).some(
    (record) =>
      record.selectionKey === 'host' &&
      (record.homeRoute === undefined ||
        record.homeRoute === 'shared-home' ||
        record.homeRoute === 'custom-home' ||
        (record.homeRoute === 'account-home' && record.accountId !== null))
  )
}

/** Drops records whose daemon PTYs are authoritatively absent. */
export function reconcileCodexPaneAccountsWithLivePtys(livePtyIds: readonly string[]): void {
  // Why: this deletes every pane not in the live list. Against an empty stand-in
  // it is a no-op, but the write it guards would still persist that stand-in
  // over the real file, so refuse rather than reconcile a registry nobody read.
  mutations.flush()
  const registry = readRegistryOrNull()
  if (!registry) {
    return
  }
  const livePtyIdSet = new Set(livePtyIds)
  let changed = false
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
    mutations.reset()
  }
}
