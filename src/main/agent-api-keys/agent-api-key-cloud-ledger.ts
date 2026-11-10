// The A5 sync ledger: per Orca account, which variables this computer wrote (and from which vault
// key) plus saves still waiting to reach the account. Names, ids and timestamps only; never values.
import { readFile } from 'node:fs/promises'
import { writeSecureFile } from '../../shared/secure-storage/secure-file'
import type { AgentApiKeySummary } from '../../shared/agent-api-keys/agent-api-key-catalog'

export type LedgerEntry = {
  /** The vault key whose value was written. */
  keyId: string
  /** That key's `updatedAt` when it was written, so a later edit that failed to sync isn't "synced". */
  keyUpdatedAt: number
  syncedAt: number
}

export type LedgerFile = {
  version: 1
  /** accountId → variable → what this computer wrote there. */
  accounts: Record<string, Record<string, LedgerEntry>>
  /**
   * accountId → key id → that key's `updatedAt`: saves made while signed in to this account that
   * haven't reached it yet. Retried on reconnect and at start; nothing else is ever uploaded unasked.
   */
  pending?: Record<string, Record<string, number>>
}

const MAX_LEDGER_BYTES = 256 * 1024

function isEntry(value: unknown): value is LedgerEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'keyId' in value &&
    'keyUpdatedAt' in value &&
    'syncedAt' in value &&
    typeof value.keyId === 'string' &&
    typeof value.keyUpdatedAt === 'number' &&
    typeof value.syncedAt === 'number'
  )
}

export function parseLedger(text: string): LedgerFile {
  const ledger: LedgerFile = { version: 1, accounts: {} }
  if (text.length > MAX_LEDGER_BYTES) {
    return ledger
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return ledger
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('accounts' in parsed) ||
    typeof parsed.accounts !== 'object' ||
    parsed.accounts === null
  ) {
    return ledger
  }
  for (const [accountId, names] of Object.entries(parsed.accounts)) {
    if (typeof names !== 'object' || names === null) {
      continue
    }
    const kept: Record<string, LedgerEntry> = {}
    for (const [name, entry] of Object.entries(names)) {
      if (isEntry(entry)) {
        kept[name] = entry
      }
    }
    ledger.accounts[accountId] = kept
  }
  if ('pending' in parsed && typeof parsed.pending === 'object' && parsed.pending !== null) {
    const pending: Record<string, Record<string, number>> = {}
    for (const [accountId, keys] of Object.entries(parsed.pending)) {
      if (typeof keys !== 'object' || keys === null) {
        continue
      }
      pending[accountId] = Object.fromEntries(
        Object.entries(keys).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number'
        )
      )
    }
    ledger.pending = pending
  }
  return ledger
}

export function pendingOf(
  keys: readonly AgentApiKeySummary[],
  pending: Record<string, number>
): { pending?: string[] } {
  const ids = keys.filter((key) => pending[key.id] === key.updatedAt).map((key) => key.id)
  return ids.length > 0 ? { pending: ids } : {}
}

/** The variables `keyId` wrote to the account (more than one after a rename). */
export function namesWrittenBy(names: Record<string, LedgerEntry>, keyId: string): string[] {
  return Object.entries(names)
    .filter(([, entry]) => entry.keyId === keyId)
    .map(([name]) => name)
}

/** The ledger file, cached: the sync is its only writer. Written 0600. */
export class CloudKeyLedger {
  private cached: LedgerFile | null = null

  constructor(private readonly path: string) {}

  async read(): Promise<LedgerFile> {
    if (this.cached) {
      return this.cached
    }
    let text = ''
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      // Missing or unreadable: nothing was synced from here that we can prove, so remove nothing.
    }
    return (this.cached = parseLedger(text))
  }

  private write(next: LedgerFile): void {
    writeSecureFile(this.path, JSON.stringify(next, null, 2))
    this.cached = next
  }

  async setNames(accountId: string, names: Record<string, LedgerEntry>): Promise<void> {
    const ledger = await this.read()
    this.write({ ...ledger, accounts: { ...ledger.accounts, [accountId]: names } })
  }

  /** Marks (a version of) a key as waiting for the account, or clears it. True when one was added. */
  async setPending(accountId: string, keyId: string, updatedAt: number | null): Promise<boolean> {
    const ledger = await this.read()
    const current = ledger.pending?.[accountId] ?? {}
    if ((current[keyId] ?? null) === updatedAt) {
      return false
    }
    const { [keyId]: _old, ...rest } = current
    const keys = updatedAt === null ? rest : { ...rest, [keyId]: updatedAt }
    this.write({ ...ledger, pending: { ...ledger.pending, [accountId]: keys } })
    return updatedAt !== null
  }

  hasPending(): boolean {
    return Object.values(this.cached?.pending ?? {}).some((keys) => Object.keys(keys).length > 0)
  }
}
