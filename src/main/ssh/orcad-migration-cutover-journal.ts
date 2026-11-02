/**
 * The cutover journal sidecar: one durable, owner-only file per migration beside the profile.
 *
 * Why not the profile store: shipped builds rewrite orca-data.json and the profile database with
 * schemas that drop unknown fields, so a journal kept there would vanish across a downgrade while
 * the target's `orcadFence`, which shipped builds keep, survived it. A missing journal must
 * never look like "no migration"; an unreadable one fails closed.
 */
import {
  MAX_ORCAD_MIGRATION_SOURCE_CUTOVERS,
  isRetainedOrcadMigrationSourceCutover,
  parseOrcadMigrationSourceCutover,
  type OrcadMigrationSourceCutover
} from '../../shared/orcad-migration-source-cutover'
import {
  createMigrationJournalDirectory,
  orderMigrationJournalChain
} from '../persistence/migrating-orcad-catalog/migration-journal-directory'

export class OrcadMigrationCutoverJournalUnreadableError extends Error {
  constructor(detail: string) {
    super(`The migration journal cannot be read, so the SSH host stays fenced: ${detail}`)
    this.name = 'OrcadMigrationCutoverJournalUnreadableError'
  }
}

type JournalChangeListener = (userDataPath: string) => void
let journalChangeListener: JournalChangeListener | null = null

/** Persistence state that follows the journal (scrollback retention) re-syncs on every change. */
export function setOrcadMigrationJournalChangeListener(
  listener: JournalChangeListener | null
): void {
  journalChangeListener = listener
}

const journals = createMigrationJournalDirectory({
  directoryName: 'orcad-migration-cutovers',
  // A manifest carries catalog rows and dormant session state, never scrollback bytes.
  maxFileBytes: 16 * 1024 * 1024,
  parse: parseOrcadMigrationSourceCutover,
  unreadable: (detail) => new OrcadMigrationCutoverJournalUnreadableError(detail),
  onChange: (userDataPath) => journalChangeListener?.(userDataPath)
})

export function orcadMigrationCutoverJournalDirectory(userDataPath: string): string {
  return journals.directory(userDataPath)
}

/** Every journaled cutover; throws rather than skipping a file it cannot trust. */
export function listOrcadMigrationSourceCutovers(
  userDataPath: string
): OrcadMigrationSourceCutover[] {
  return journals.list(userDataPath)
}

/** The target's current cutover: the head of its chain, which no later delta move supersedes. */
export function findOrcadMigrationSourceCutoverForTarget(
  userDataPath: string,
  sshTargetId: string
): OrcadMigrationSourceCutover | null {
  const chain = listOrcadMigrationCutoverChainForTarget(userDataPath, sshTargetId)
  return chain.at(-1) ?? null
}

/** Oldest first; throws unless the target's journals form one chain of delta moves. */
export function listOrcadMigrationCutoverChainForTarget(
  userDataPath: string,
  sshTargetId: string
): OrcadMigrationSourceCutover[] {
  const matches = listOrcadMigrationSourceCutovers(userDataPath).filter(
    (cutover) => cutover.sshTargetId === sshTargetId
  )
  return orderMigrationJournalChain(
    matches,
    (detail) => new OrcadMigrationCutoverJournalUnreadableError(detail),
    `SSH target ${sshTargetId}`
  )
}

/** Durable before it returns: a fence written after this always has its journal on disk. */
export function writeOrcadMigrationSourceCutover(
  userDataPath: string,
  cutover: OrcadMigrationSourceCutover
): void {
  const parsed = parseOrcadMigrationSourceCutover(cutover)
  const existing = listOrcadMigrationSourceCutovers(userDataPath)
  // Why in flight only: a retained cutover is finished and may wait two releases for retirement.
  const inFlight = existing.filter(
    (entry) => entry.phase !== 'source-retired' && !isRetainedOrcadMigrationSourceCutover(entry)
  )
  if (
    !existing.some((entry) => entry.migrationId === parsed.migrationId) &&
    inFlight.length >= MAX_ORCAD_MIGRATION_SOURCE_CUTOVERS
  ) {
    throw new Error('orcad_migration_cutover_capacity_exceeded')
  }
  journals.write(userDataPath, parsed)
}

export function removeOrcadMigrationSourceCutover(userDataPath: string, migrationId: string): void {
  journals.remove(userDataPath, migrationId)
}

/** Every journal a host's stopped or never-registered server leaves behind; they grant nothing. */
export function removeOrcadMigrationJournalsForDestination(
  userDataPath: string,
  sshTargetId: string,
  environmentId: string
): void {
  for (const cutover of listOrcadMigrationSourceCutovers(userDataPath)) {
    if (cutover.sshTargetId === sshTargetId && cutover.destinationEnvironmentId === environmentId) {
      removeOrcadMigrationSourceCutover(userDataPath, cutover.migrationId)
    }
  }
}
