import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { readAgentStateJsonFileSync } from '../../codex/configuration/agent-state-file-reader'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'

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

export type CreatedTrustRecord = { configPath: string; projectPath: string; written: string }

export type AgentTrustOwnershipLedger = {
  record: (configPath: string, projectPath: string, written: string) => void
  /**
   * One read and at most one publication for a whole grant. Forgets only entries with exactly the
   * given bytes; returns the records it added, skipping paths already recorded.
   */
  apply: (changes: {
    record?: readonly CreatedTrustRecord[]
    forget?: readonly CreatedTrustRecord[]
  }) => CreatedTrustRecord[]
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
  ledgerPath: () => string,
  normalizePath: (projectPath: string) => string
): AgentTrustOwnershipLedger {
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

  const apply: AgentTrustOwnershipLedger['apply'] = ({ record = [], forget = [] }) => {
    if (record.length === 0 && forget.length === 0) {
      return []
    }
    const ledger = read()
    let changed = false
    for (const { configPath, projectPath, written } of forget) {
      const entries = ledger.created[configPath] ?? []
      const remaining = entries.filter(
        (recorded) => !(matches(recorded, projectPath) && recorded.written === written)
      )
      if (remaining.length !== entries.length) {
        changed = true
        if (remaining.length === 0) {
          delete ledger.created[configPath]
        } else {
          ledger.created[configPath] = remaining
        }
      }
    }
    const added: CreatedTrustRecord[] = []
    for (const entry of record) {
      if (find(ledger, entry.configPath, entry.projectPath)) {
        continue
      }
      ledger.created[entry.configPath] = [
        ...(ledger.created[entry.configPath] ?? []),
        { path: entry.projectPath, written: entry.written }
      ]
      added.push(entry)
      changed = true
    }
    if (changed) {
      write(ledger)
    }
    return added
  }

  return {
    record: (configPath, projectPath, written) => {
      apply({ record: [{ configPath, projectPath, written }] })
    },
    apply,
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
