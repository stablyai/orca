/**
 * The WSL move journal: `orcad-migration-cutovers-wsl/<migrationId>.json` beside the profile.
 * A separate directory from the SSH journal, so an older build never reads a WSL record as SSH.
 */
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
import { assertWslMoveManifestFits } from './wsl-move-manifest-budget'
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

/** Runs after every durable write or removal; returns the unsubscribe. */
export function onWslMoveJournalChange(listener: (userDataPath: string) => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

const journals = createMigrationJournalDirectory({
  directoryName: 'orcad-migration-cutovers-wsl',
  // A manifest carries catalog rows and dormant session state; blobs travel on their own channel.
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

/** Detached copies: a caller editing one must not change what the next write compares against. */
export function listWslMoveCutovers(userDataPath: string): WslMoveCutover[] {
  return journals.list(userDataPath).map((cutover) => structuredClone(cutover))
}

/** Shared, not copied, for read-only scans on hot paths such as fence checks. Never mutate. */
export function scanWslMoveCutovers(userDataPath: string): readonly Readonly<WslMoveCutover>[] {
  return journals.list(userDataPath)
}

/** The record's own fields, plus the manifest's digest recomputed: a scope edit cannot pass. */
function parseVerifiedWslMoveCutover(value: unknown): WslMoveCutover {
  const cutover = parseWslMoveCutover(value)
  // Raw, not parsed: parsing drops fields a newer build signed.
  assertOrcadMigrationManifestDigest(isRecord(value) ? value.manifest : undefined)
  return cutover
}

/** Oldest first; throws unless the distro's journals form one chain of delta moves. */
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

/**
 * Durable before it returns. A record starts at `prepared` and then advances one phase at a time
 * from the one on disk. A new move into a distro must extend the head of its chain, and only
 * once that head finished: one in-flight move per distro (design, section 4.3).
 */
export function writeWslMoveCutover(userDataPath: string, cutover: WslMoveCutover): void {
  const parsed = parseVerifiedWslMoveCutover(cutover)
  // Files are named by migration id alone: one id must never name moves of two distros.
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
  // Compare-and-swap: a writer whose record was lifted underneath it must not recreate the fence.
  if (!existing && parsed.phase !== 'prepared') {
    throw new Error('wsl_move_record_missing')
  }
  if (!existing && parsed.rewrittenStores.length > 0) {
    throw new Error('wsl_move_ledger_changed')
  }
  if (!existing && parsed.terminalRestoreHints !== undefined) {
    throw new Error('wsl_move_restore_hints_changed')
  }
  if (!existing) {
    // New moves only: a record already on disk must stay resumable whatever its size.
    assertWslMoveManifestFits(parsed.manifest)
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

/** A record only moves forward, keeps its binding, and only the head of its chain still moves. */
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
  assertWslMoveRestoreHintsUpdate(existing, next)
  assertWslMoveAutomationsUpdate(existing, next)
}

/** Written once, with the `quiesced` record that captured them, and never changed after. */
/** Part of the move's binding: written with the record and never changed. */
function assertWslMoveAutomationsUpdate(existing: WslMoveCutover, next: WslMoveCutover): void {
  if (
    JSON.stringify(existing.automationsToReenable) !== JSON.stringify(next.automationsToReenable)
  ) {
    throw new Error('wsl_move_binding_changed')
  }
}

function assertWslMoveRestoreHintsUpdate(existing: WslMoveCutover, next: WslMoveCutover): void {
  const before = existing.terminalRestoreHints
  const after = next.terminalRestoreHints
  if (before === undefined && after === undefined) {
    return
  }
  if (before !== undefined) {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('wsl_move_restore_hints_changed')
    }
    return
  }
  if (existing.phase !== 'source-fenced' || next.phase !== 'quiesced') {
    throw new Error('wsl_move_restore_hints_changed')
  }
}

/**
 * The rewrite ledger, and the seeded host workspaces beside it, only grow, and only while the
 * desktop rewrites (`destination-committed`):
 * append-only and without duplicates, so a stale writer cannot drop another's entry. Leaving that
 * phase needs a complete registry and every registered store recorded.
 */
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
  const seededBefore = existing.seededHostWorkspaceIds ?? []
  const seededAfter = new Set(next.seededHostWorkspaceIds ?? [])
  if (
    !seededBefore.every((id) => seededAfter.has(id)) ||
    (seededAfter.size > seededBefore.length &&
      (existing.phase !== 'destination-committed' || next.phase !== 'destination-committed'))
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

// Before quiesce nothing has reached the destination, so lifting the fence loses nothing.
const REMOVABLE_IN_FLIGHT_PHASES: ReadonlySet<WslMoveCutover['phase']> = new Set([
  'prepared',
  'source-fenced'
])

/**
 * Only a record whose move has touched nothing beyond the source goes, or one finished. A move
 * further along keeps its fence until it resumes, or until a cancel proves the destination holds
 * nothing.
 */
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
  removeNewestInChain(userDataPath, record)
}

/**
 * Only the newest move of a distro goes: a later move names this one as what it supersedes, so
 * removing it would break the chain and leave every project of that distro unreadable.
 */
function removeNewestInChain(userDataPath: string, record: WslMoveCutover | undefined): void {
  if (!record) {
    return
  }
  if (
    listWslMoveCutoverChain(userDataPath, record.journalKey).at(-1)?.migrationId !==
    record.migrationId
  ) {
    throw new Error('wsl_move_superseded')
  }
  journals.remove(userDataPath, record.migrationId)
}

/**
 * Resets a move that never reached `destination-committed`; the caller has proved the destination
 * holds no commit of it (wsl-move-reset). Its fence and session freeze lift with the record.
 */
export function removeUncommittedWslMoveCutover(userDataPath: string, migrationId: string): void {
  const record = listWslMoveCutovers(userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (
    record &&
    WSL_MOVE_CUTOVER_PHASES.indexOf(record.phase) >=
      WSL_MOVE_CUTOVER_PHASES.indexOf('destination-committed')
  ) {
    throw new Error('wsl_move_committed')
  }
  removeNewestInChain(userDataPath, record)
}
