// Persistent ownership ledger for alternate Claude config dirs. Updates use
// an atomic compare-and-retry replace because the Electron main process and
// offline CLI can both update the same userData file.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isClaudeFlavorConfigDirName } from './claude-config-dir-discovery'

type ClaudeConfigDirLedger = {
  version: 1
  configDirNames: string[]
}

function normalizeConfigDirNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return [
    ...new Set(
      value.filter(
        (name): name is string => typeof name === 'string' && isClaudeFlavorConfigDirName(name)
      )
    )
  ].sort()
}

function parseClaudeConfigDirLedger(raw: string | null): string[] {
  if (raw === null) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as { configDirNames?: unknown }
    return normalizeConfigDirNames(parsed?.configDirNames)
  } catch {
    return []
  }
}

function readLedgerBaseline(ledgerPath: string): string | null {
  try {
    return readFileSync(ledgerPath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export function readClaudeConfigDirLedger(ledgerPath: string): string[] {
  try {
    return parseClaudeConfigDirLedger(readLedgerBaseline(ledgerPath))
  } catch {
    // Status and cleanup remain fail-open when the Orca-owned ledger itself
    // cannot be read; install/update paths use the strict reader below.
    return []
  }
}

export function updateClaudeConfigDirLedger(
  ledgerPath: string,
  mutate: (current: string[]) => string[],
  maxAttempts = 3
): string[] {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const baseline = readLedgerBaseline(ledgerPath)
    const next = normalizeConfigDirNames(mutate(parseClaudeConfigDirLedger(baseline)))
    if (writeClaudeConfigDirLedger(ledgerPath, next, baseline)) {
      return next
    }
  }
  throw new Error('Could not update Claude config-dir ledger after concurrent writes')
}

function writeClaudeConfigDirLedger(
  ledgerPath: string,
  dirNames: string[],
  expectedDiskContent: string | null
): boolean {
  mkdirSync(dirname(ledgerPath), { recursive: true })
  const ledger: ClaudeConfigDirLedger = { version: 1, configDirNames: dirNames }
  const serialized = `${JSON.stringify(ledger, null, 2)}\n`
  if (readLedgerBaseline(ledgerPath) === serialized) {
    return true
  }

  const tmpPath = join(dirname(ledgerPath), `.${Date.now()}-${randomUUID()}.tmp`)
  try {
    writeFileSync(tmpPath, serialized, 'utf-8')
    // Why: a second Orca process may have updated the shared ledger after our
    // read. Abort and re-merge instead of replacing its newly tracked dirs.
    if (readLedgerBaseline(ledgerPath) !== expectedDiskContent) {
      return false
    }
    renameSync(tmpPath, ledgerPath)
    return true
  } finally {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // Best-effort cleanup after a failed or stale replace.
      }
    }
  }
}
