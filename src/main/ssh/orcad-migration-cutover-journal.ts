/** Persist journals in owner-only profile sidecars: older profile schemas drop unknown fields but retain fences, so an in-profile journal could vanish on downgrade. Unreadable journals fail closed. */
import {
  MAX_ORCAD_MIGRATION_SOURCE_CUTOVERS,
  isRetainedOrcadMigrationSourceCutover,
  parseOrcadMigrationSourceCutover,
  type OrcadMigrationSourceCutover
} from '../../shared/orcad-migration/orcad-migration-source-cutover'
import {
  createMigrationJournalDirectory,
  orderMigrationJournalChain
} from '../persistence/migrating-orcad-catalog/migration-journal-directory'

class OrcadMigrationCutoverJournalUnreadableError extends Error {
  constructor(detail: string) {
    super(`The migration journal cannot be read, so the SSH host stays fenced: ${detail}`)
    this.name = 'OrcadMigrationCutoverJournalUnreadableError'
  }
}

type JournalChangeListener = (userDataPath: string) => void
let journalChangeListener: JournalChangeListener | null = null

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

/** Never skip an unreadable or untrusted journal. */
export function listOrcadMigrationSourceCutovers(
  userDataPath: string
): OrcadMigrationSourceCutover[] {
  return journals.list(userDataPath)
}

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

/** Flush before returning so later fence writes always have a durable journal. */
export function writeOrcadMigrationSourceCutover(
  userDataPath: string,
  cutover: OrcadMigrationSourceCutover
): void {
  const parsed = parseOrcadMigrationSourceCutover(cutover)
  const existing = listOrcadMigrationSourceCutovers(userDataPath)
  // Finished retained cutovers can wait two releases; only in-flight journals count toward the bound.
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
