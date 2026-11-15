import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readAgentStateJsonFileSync } from '../../codex/configuration/agent-state-file-reader'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
import { getOrcaUserDataPath } from '../../codex/configuration/homes/codex-home-paths'

/**
 * Ownership records for the workspace trust entries Orca's preflight created in
 * an agent's config, so a removed worktree's entry can be deleted without ever
 * touching one the user (or an older Orca build) had at that path. Each record
 * carries exactly what the grant wrote, so an entry replaced afterwards is no
 * longer Orca's to delete.
 */

type CreatedTrustEntry = {
  path: string
  /** What the grant wrote for the path, compared before removal. */
  written: string
}

type CreatedTrustLedger = {
  version: 1
  /** Config file path → the entries Orca's grant created there. */
  created: Record<string, CreatedTrustEntry[]>
}

export type AgentTrustOwnershipLedger = {
  record: (configPath: string, projectPath: string, written: string) => void
  getWritten: (configPath: string, projectPath: string) => string | null
  listConfigFiles: (projectPath: string) => string[]
  forget: (configPath: string, projectPath: string) => void
}

function isCreatedTrustEntry(entry: unknown): entry is CreatedTrustEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'path' in entry &&
    typeof entry.path === 'string' &&
    'written' in entry &&
    typeof entry.written === 'string'
  )
}

function isCreatedTrustEntryMap(value: unknown): value is Record<string, CreatedTrustEntry[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  return Object.values(value).every(
    (entries) => Array.isArray(entries) && entries.every(isCreatedTrustEntry)
  )
}

export function createAgentTrustOwnershipLedger(
  fileName: string,
  normalizePath: (projectPath: string) => string
): AgentTrustOwnershipLedger {
  const ledgerPath = (): string => join(getOrcaUserDataPath(), fileName)

  // Why: the ledger only decides what extra cleanup may happen, so any unreadable
  // state degrades to "nothing recorded", never to deleting an unrecorded entry.
  const read = (): CreatedTrustLedger => {
    try {
      const parsed: unknown = readAgentStateJsonFileSync(ledgerPath())
      return typeof parsed === 'object' &&
        parsed !== null &&
        'created' in parsed &&
        isCreatedTrustEntryMap(parsed.created)
        ? { version: 1, created: parsed.created }
        : { version: 1, created: {} }
    } catch {
      return { version: 1, created: {} }
    }
  }

  const write = (ledger: CreatedTrustLedger): void => {
    const path = ledgerPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileAtomically(path, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
  }

  const matches = (recorded: CreatedTrustEntry, projectPath: string): boolean =>
    normalizePath(recorded.path) === normalizePath(projectPath)

  const find = (ledger: CreatedTrustLedger, configPath: string, projectPath: string) =>
    (ledger.created[configPath] ?? []).find((recorded) => matches(recorded, projectPath))

  return {
    record: (configPath, projectPath, written) => {
      const ledger = read()
      if (find(ledger, configPath, projectPath)) {
        return
      }
      ledger.created[configPath] = [
        ...(ledger.created[configPath] ?? []),
        { path: projectPath, written }
      ]
      write(ledger)
    },
    getWritten: (configPath, projectPath) => find(read(), configPath, projectPath)?.written ?? null,
    listConfigFiles: (projectPath) =>
      Object.entries(read().created)
        .filter(([, entries]) => entries.some((recorded) => matches(recorded, projectPath)))
        .map(([configPath]) => configPath),
    forget: (configPath, projectPath) => {
      const ledger = read()
      const entries = ledger.created[configPath] ?? []
      const remaining = entries.filter((recorded) => !matches(recorded, projectPath))
      if (remaining.length === entries.length) {
        return
      }
      if (remaining.length === 0) {
        delete ledger.created[configPath]
      } else {
        ledger.created[configPath] = remaining
      }
      write(ledger)
    }
  }
}
