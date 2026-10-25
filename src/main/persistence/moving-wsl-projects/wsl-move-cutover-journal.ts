// Separate WSL journals prevent older builds from interpreting these records as SSH moves.
import {
  WSL_MOVE_CUTOVER_PHASES,
  isWslMoveCutoverFinished,
  parseWslMoveCutover,
  type WslMoveCutover
} from '../../../shared/wsl-move/wsl-move-cutover'
import { isRecord } from '../../../shared/orcad-migration/orcad-migration-manifest-fields'
import { assertOrcadMigrationManifestDigest } from '../../orcad/orcad-migration-manifest-digest'
import {
  createMigrationJournalDirectory,
  orderMigrationJournalChain
} from '../migrating-orcad-catalog/migration-journal-directory'
import {
  isWslMoveDesktopRewriteRegistryComplete,
  pendingWslMoveDesktopRewriteStores
} from './wsl-move-desktop-rewrite-stores'

export class WslMoveJournalUnreadableError extends Error {
  constructor(detail: string) {
    super(`The WSL move journal cannot be read, so the moving projects stay fenced: ${detail}`)
    this.name = 'WslMoveJournalUnreadableError'
  }
}

const changeListeners = new Set<(userDataPath: string) => void>()

/** Subscribe after durable writes/removals; returns unsubscribe. */
export function onWslMoveJournalChange(listener: (userDataPath: string) => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

const journals = createMigrationJournalDirectory({
  directoryName: 'orcad-migration-cutovers-wsl',
  // Journals embed catalog/session manifests; blobs use a separate channel.
  maxFileBytes: 16 * 1024 * 1024,
  parse: parseVerifiedWslMoveCutover,
  unreadable: (detail) => new WslMoveJournalUnreadableError(detail),
  onChange: (userDataPath) => {
    for (const listener of changeListeners) {
      listener(userDataPath)
    }
  }
})

export function wslMoveJournalDirectory(userDataPath: string): string {
  return journals.directory(userDataPath)
}

/** Detached copies prevent callers from changing future write comparisons. */
export function listWslMoveCutovers(userDataPath: string): WslMoveCutover[] {
  return journals.list(userDataPath).map((cutover) => structuredClone(cutover))
}

/** Shared cache for hot read-only scans; never mutate. */
export function scanWslMoveCutovers(userDataPath: string): readonly Readonly<WslMoveCutover>[] {
  return journals.list(userDataPath)
}

/** Recompute the manifest digest to reject scope edits. */
function parseVerifiedWslMoveCutover(value: unknown): WslMoveCutover {
  const cutover = parseWslMoveCutover(value)
  // Verify raw fields: parsing drops fields signed by newer builds.
  assertOrcadMigrationManifestDigest(isRecord(value) ? value.manifest : undefined)
  return cutover
}

/** Oldest-first delta chain; forks and gaps fail closed. */
export function listWslMoveCutoverChain(
  userDataPath: string,
  journalKey: string
): WslMoveCutover[] {
  const matches = listWslMoveCutovers(userDataPath).filter(
    (cutover) => cutover.journalKey === journalKey
  )
  return orderMigrationJournalChain(
    matches,
    (detail) => new WslMoveJournalUnreadableError(detail),
    journalKey
  )
}

/** Durably advance one phase at a time; only a finished chain head permits a new distro move. */
export function writeWslMoveCutover(userDataPath: string, cutover: WslMoveCutover): void {
  const parsed = parseVerifiedWslMoveCutover(cutover)
  // Migration-ID filenames must never conflate two distros.
  if (
    listWslMoveCutovers(userDataPath).some(
      (entry) => entry.migrationId === parsed.migrationId && entry.journalKey !== parsed.journalKey
    )
  ) {
    throw new Error('wsl_move_id_in_use')
  }
  const chain = listWslMoveCutoverChain(userDataPath, parsed.journalKey)
  const existing = chain.find((entry) => entry.migrationId === parsed.migrationId)
  const head = chain.at(-1)
  // A stale writer must not recreate a removed fence.
  if (!existing && parsed.phase !== 'prepared') {
    throw new Error('wsl_move_record_missing')
  }
  if (!existing && parsed.rewrittenStores.length > 0) {
    throw new Error('wsl_move_ledger_changed')
  }
  if (existing) {
    assertWslMoveUpdate(existing, parsed, head)
  } else if (!head) {
    if (parsed.supersedesMigrationId !== undefined) {
      throw new Error('wsl_move_must_extend_its_chain')
    }
  } else {
    if (!isWslMoveCutoverFinished(head)) {
      throw new Error('wsl_move_already_in_flight')
    }
    if (parsed.supersedesMigrationId !== head.migrationId) {
      throw new Error('wsl_move_must_extend_its_chain')
    }
  }
  journals.write(userDataPath, parsed)
}

/** Only the chain head advances; preserve its binding. */
function assertWslMoveUpdate(
  existing: WslMoveCutover,
  next: WslMoveCutover,
  head: WslMoveCutover | undefined
): void {
  if (
    next.manifestSha256 !== existing.manifestSha256 ||
    next.supersedesMigrationId !== existing.supersedesMigrationId
  ) {
    throw new Error('wsl_move_binding_changed')
  }
  const order = (phase: WslMoveCutover['phase']): number => WSL_MOVE_CUTOVER_PHASES.indexOf(phase)
  if (order(next.phase) < order(existing.phase)) {
    throw new Error('wsl_move_phase_regressed')
  }
  if (order(next.phase) > order(existing.phase) + 1) {
    throw new Error('wsl_move_phase_skipped')
  }
  if (head && head.migrationId !== existing.migrationId && next.phase !== existing.phase) {
    throw new Error('wsl_move_superseded')
  }
  assertWslMoveLedgerUpdate(existing, next)
}

/** Append-only during destination-committed; leaving requires every store in a complete registry. */
function assertWslMoveLedgerUpdate(existing: WslMoveCutover, next: WslMoveCutover): void {
  const before = existing.rewrittenStores
  const after = next.rewrittenStores
  const kept = before.every((id, index) => after[index] === id)
  if (!kept || new Set(after).size !== after.length) {
    throw new Error('wsl_move_ledger_changed')
  }
  if (
    after.length > before.length &&
    (existing.phase !== 'destination-committed' || next.phase !== 'destination-committed')
  ) {
    throw new Error('wsl_move_ledger_changed')
  }
  if (
    existing.phase === 'destination-committed' &&
    next.phase === 'client-rewritten' &&
    (!isWslMoveDesktopRewriteRegistryComplete() ||
      pendingWslMoveDesktopRewriteStores(after).length > 0)
  ) {
    throw new Error('wsl_move_rewrite_incomplete')
  }
}

// Before quiesce, removing the fence cannot lose destination state.
const REMOVABLE_IN_FLIGHT_PHASES: ReadonlySet<WslMoveCutover['phase']> = new Set([
  'prepared',
  'source-fenced'
])

/** Retain unfinished fences after quiesce until resume or a cancel proves the destination empty. */
export function removeWslMoveCutover(userDataPath: string, migrationId: string): void {
  const record = listWslMoveCutovers(userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (
    record &&
    !REMOVABLE_IN_FLIGHT_PHASES.has(record.phase) &&
    !isWslMoveCutoverFinished(record)
  ) {
    throw new Error('wsl_move_in_flight')
  }
  journals.remove(userDataPath, migrationId)
}
