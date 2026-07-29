import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getOrcaUserDataPath } from './codex-home-paths'

/**
 * Remembers which Codex account each live PTY was launched under.
 *
 * Why: `CODEX_HOME` is baked into a PTY's environment at spawn and can never be
 * changed afterwards, so a shell keeps launching Codex against the account that
 * was selected when the terminal opened. The daemon keeps those shells alive
 * across app restarts, so without an on-disk record Orca forgets a pane is on
 * the old account and the user is stuck there with no prompt to escape it.
 */

export type CodexPaneAccountRecord = {
  /** 'host' or 'wsl:<distro>' — the selection lane this pane launched from. */
  selectionKey: string
  /** Managed account id, or null for the system-default account. */
  accountId: string | null
}

type RegistryFile = {
  version: 1
  panes: Record<string, CodexPaneAccountRecord>
}

// Why: bounds a file that only shrinks when Orca observes a PTY exit; a crash
// mid-session would otherwise leak an entry per terminal, forever.
const MAX_TRACKED_PANES = 2000

let cachedRegistry: RegistryFile | null = null

function getRegistryPath(): string {
  return join(getOrcaUserDataPath(), 'codex-pane-accounts.json')
}

function readRegistry(): RegistryFile {
  if (cachedRegistry) {
    return cachedRegistry
  }
  cachedRegistry = parseRegistry(readRegistryFile())
  return cachedRegistry
}

function readRegistryFile(): unknown {
  try {
    return JSON.parse(readFileSync(getRegistryPath(), 'utf-8'))
  } catch {
    return null
  }
}

function parseRegistry(parsed: unknown): RegistryFile {
  const empty: RegistryFile = { version: 1, panes: {} }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return empty
  }
  const panes = (parsed as Partial<RegistryFile>).panes
  if (!panes || typeof panes !== 'object' || Array.isArray(panes)) {
    return empty
  }
  for (const [ptyId, record] of Object.entries(panes)) {
    if (isPaneAccountRecord(record)) {
      empty.panes[ptyId] = { selectionKey: record.selectionKey, accountId: record.accountId }
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
    typeof record.selectionKey === 'string' &&
    (record.accountId === null || typeof record.accountId === 'string')
  )
}

function writeRegistry(registry: RegistryFile): void {
  const registryPath = getRegistryPath()
  const temporaryPath = `${registryPath}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(registryPath), { recursive: true })
    writeFileSync(temporaryPath, `${JSON.stringify(registry)}\n`, {
      encoding: 'utf-8',
      mode: 0o600
    })
    renameSync(temporaryPath, registryPath)
  } catch (error) {
    // Why: this record only powers a restart hint; losing it must never break a
    // terminal spawn or a PTY teardown — including when the cleanup itself fails.
    console.warn('[codex-pane-accounts] Failed to persist pane account registry:', error)
    try {
      rmSync(temporaryPath, { force: true })
    } catch {}
  }
}

/**
 * Records the account a PTY launched under. Pass null to forget a pinned pane.
 */
export function recordCodexPaneAccount(ptyId: string, record: CodexPaneAccountRecord | null): void {
  const registry = readRegistry()
  if (!record) {
    if (!(ptyId in registry.panes)) {
      return
    }
    delete registry.panes[ptyId]
    writeRegistry(registry)
    return
  }
  const existing = registry.panes[ptyId]
  if (existing?.selectionKey === record.selectionKey && existing.accountId === record.accountId) {
    return
  }
  registry.panes[ptyId] = record
  const trackedPtyIds = Object.keys(registry.panes)
  if (trackedPtyIds.length > MAX_TRACKED_PANES) {
    for (const staleId of trackedPtyIds.slice(0, trackedPtyIds.length - MAX_TRACKED_PANES)) {
      delete registry.panes[staleId]
    }
  }
  writeRegistry(registry)
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

/**
 * Reports the lane each given PTY launched from, omitting panes with no record.
 *
 * Why the renderer needs this: an account switch has to know which panes the
 * change could have stranded, and this key was written from the shell, cwd and
 * distro the spawn actually resolved. Re-deriving it from current settings
 * answers for a launch that never happened once the user edits those settings.
 */
export function listRecordedCodexPaneLanes(ptyIds: readonly string[]): Record<string, string> {
  const registry = readRegistry()
  const lanesByPtyId: Record<string, string> = {}
  for (const ptyId of ptyIds) {
    const record = registry.panes[ptyId]
    if (record) {
      lanesByPtyId[ptyId] = record.selectionKey
    }
  }
  return lanesByPtyId
}

export const _internals = {
  resetCache: (): void => {
    cachedRegistry = null
  }
}
