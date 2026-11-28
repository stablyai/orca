import type { JournalSqlMaintenance } from './journal-sql-maintenance'

export class JournalRetirementCancelledError extends Error {
  override readonly name: string = 'JournalRetirementCancelledError'

  constructor(readonly outcome: 'not-dispatched' | 'rolled-back' = 'not-dispatched') {
    super('legacy journal retirement was cancelled')
  }
}

export class JournalRetirementRecordsPendingError extends JournalRetirementCancelledError {
  override readonly name = 'JournalRetirementRecordsPendingError'
}

export type JournalRetirementAuthority = {
  permit: Int32Array
  signal: AbortSignal
}

export function requireJournalRetirementPermit(
  kind: JournalSqlMaintenance['kind'],
  permit: Int32Array | undefined
): void {
  if (permit) {
    return
  }
  switch (kind) {
    case 'legacy-retirement-state':
    case 'legacy-retirement-save':
    case 'legacy-retirement-reported':
    case 'legacy-originals-keep':
    case 'legacy-claims-absorb':
      throw new JournalRetirementCancelledError()
  }
}

export function assertJournalRetirementPermit(permit: Int32Array | undefined): void {
  if (permit && Atomics.load(permit, 0) !== 1) {
    throw new JournalRetirementCancelledError()
  }
}
