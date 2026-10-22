import { existsSync, readFileSync } from 'node:fs'
import type Database from '../../sqlite/sync-database'
import {
  ProfileStateRecoveryCommandError,
  type ProfileStateRecoveryRepairSection
} from '../../../shared/profile-state-recovery-command'
import type { ProfileStateMaintenance } from './profile-state-access'
import { profileHasPendingProjectMove } from '../../orca-profiles/profile-project-move-record'
import { readProfileStateAutomationRunsDocument } from './profile-state-automation-runs'
import { profileStateDatabaseBackups } from './profile-state-backup-path'
import {
  openProfileStateDatabaseReadOnly,
  openWritableProfileStateDatabase
} from './profile-state-database'
import { quarantineProfileStateDatabase } from './profile-state-database-quarantine'
import { importProfileStateJson } from './profile-state-documents'
import {
  ProfileStateDocumentCorruptionError,
  isRecord,
  validateProfileStateDocumentRow,
  type ProfileStateParsedDocument
} from './profile-state-document-validation'
import { readProfileStateDomainsWithRevisionFromDatabase } from './profile-state-domain-reader'
import { withProfileStateReadSnapshot } from './profile-state-read-snapshot'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import {
  assertProfileStateRepairRevision,
  readProfileStateRevision
} from './profile-state-revision'

export type ProfileStateRepairSection = {
  domain: string
  /** The newest retained backup holding a readable copy, or null when the section starts empty. */
  backupId: string | null
  backupCreatedAtMs?: number
}

export type ProfileStateSectionRepairPlan = {
  profileId: string
  revision: number
  sections: readonly ProfileStateRepairSection[]
  /** The whole profile after repair: every intact live section plus each damaged section's backup value. */
  repairedState: Record<string, unknown>
}

type ProfileStateLocation = { databaseFile: string; profileId: string; userDataPath?: string }

export type ProfileStateSectionRepairResult = {
  revision: number
  quarantineDirectory: string
  sections: readonly ProfileStateRepairSection[]
}

/**
 * Replace only the damaged sections, keeping every intact section's current value. Refuses when
 * the damage or the chosen backups differ from what the user approved.
 */
export function repairProfileStateSections(options: {
  maintenance: ProfileStateMaintenance
  location: ProfileStateLocation & { dataFile: string }
  approved?: readonly ProfileStateRecoveryRepairSection[]
  beforeRepair: () => void
}): ProfileStateSectionRepairResult {
  const { location } = options
  options.maintenance.assertProfile(location.profileId, location.dataFile, location.databaseFile)
  let plan: ProfileStateSectionRepairPlan | undefined
  let reason = 'no damaged sections were found'
  try {
    plan = planProfileStateSectionRepair(location)
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }
  if (plan === undefined) {
    throw new ProfileStateRecoveryCommandError(
      'runtime_error',
      `Orca can't repair this profile one section at a time (${reason}). Nothing was changed. Run \`orca profile state exports\` and restore a whole backup with \`orca profile state rollback --backup <id>\`.`
    )
  }
  if (options.approved !== undefined && !sameSections(options.approved, plan.sections)) {
    throw new ProfileStateRecoveryCommandError(
      'runtime_error',
      'The damaged sections or their backups changed since you chose to repair. Nothing was changed.'
    )
  }
  // The pre-repair file is the only copy of the damaged bytes, so no copy means no repair.
  const quarantine = quarantineProfileStateDatabase(
    location.databaseFile,
    location.profileId,
    undefined,
    'profile-state-repair-damaged-sections'
  )
  options.beforeRepair()
  const opened = openWritableProfileStateDatabase(location.databaseFile, location.profileId)
  let revision: number
  try {
    revision = importProfileStateJson(opened.db, JSON.stringify(plan.repairedState), {
      expectedRevision: plan.revision
    })
  } finally {
    opened.db.close()
  }
  assertProfileOpens(location, quarantine.directory)
  return { revision, quarantineDirectory: quarantine.directory, sections: plan.sections }
}

/** Run the read ordinary startup runs, so a repair that still won't open says so now. */
function assertProfileOpens(
  location: ProfileStateLocation & { dataFile: string },
  quarantineDirectory: string
): void {
  const authority = new ProfileStateSqliteAuthority(location.databaseFile, location.profileId)
  try {
    const opened = existsSync(location.dataFile)
      ? authority.readAcceptedState(readFileSync(location.dataFile, 'utf8'))
      : authority.readInitialState()
    if (opened === undefined) {
      throw new Error('the retained JSON copy no longer matches')
    }
  } catch (error) {
    throw new ProfileStateRecoveryCommandError(
      'runtime_error',
      `Orca replaced the damaged sections, but the profile still can't be opened (${error instanceof Error ? error.message : String(error)}). The profile as it was before the repair is kept in ${quarantineDirectory}.`
    )
  } finally {
    authority.close()
  }
}

function sameSections(
  approved: readonly ProfileStateRecoveryRepairSection[],
  planned: readonly ProfileStateRepairSection[]
): boolean {
  const key = (sections: readonly ProfileStateRecoveryRepairSection[]): string =>
    JSON.stringify(sections.map(({ domain, backupId }) => `${domain}\0${backupId}`).sort())
  return key(approved) === key(planned)
}

/**
 * Plan a repair when only some sections fail their checks; undefined means the damage isn't
 * confined to sections. Whole-file damage (open, schema, profile revision) throws.
 */
export function planProfileStateSectionRepair(
  location: ProfileStateLocation
): ProfileStateSectionRepairPlan | undefined {
  if (
    location.userDataPath === undefined ||
    profileHasPendingProjectMove(location.profileId, location.userDataPath)
  ) {
    return undefined
  }
  const opened = openProfileStateDatabaseReadOnly(location.databaseFile, location.profileId)
  let scan: SectionScan | undefined
  try {
    scan = withProfileStateReadSnapshot(opened.db, () => scanProfileStateSections(opened.db))
  } finally {
    opened.db.close()
  }
  if (scan === undefined || scan.damaged.size === 0) {
    return undefined
  }
  const repairedState = scan.intact
  const backups = profileStateDatabaseBackups(location.databaseFile)
  const resolved = new Map<string, ProfileStateRepairSection>()
  for (const backup of backups) {
    const pending = [...scan.damaged].filter((domain) => !resolved.has(domain))
    if (pending.length === 0) {
      break
    }
    let candidate: ReturnType<typeof openProfileStateDatabaseReadOnly>
    try {
      candidate = openProfileStateDatabaseReadOnly(backup.path, location.profileId)
    } catch {
      continue
    }
    try {
      for (const domain of pending) {
        const read = readProfileStateDomainsWithRevisionFromDatabase(candidate.db, [domain])
        if (read.kind === 'unreadable') {
          continue
        }
        if (read.values.has(domain)) {
          repairedState.set(domain, read.values.get(domain))
        }
        resolved.set(domain, {
          domain,
          backupId: backup.id,
          backupCreatedAtMs: backup.createdAtMs
        })
      }
    } finally {
      candidate.db.close()
    }
  }
  const sections = [...scan.damaged].map(
    (domain) => resolved.get(domain) ?? { domain, backupId: null }
  )
  return {
    profileId: location.profileId,
    revision: scan.revision,
    sections,
    repairedState: Object.fromEntries(repairedState)
  }
}

type SectionScan = { revision: number; intact: Map<string, unknown>; damaged: Set<string> }

function scanProfileStateSections(db: Database.Database): SectionScan | undefined {
  const revision = readProfileStateRevision(db)
  // Without a committed profile revision nothing can tell a damaged row from a damaged counter.
  if (revision === 0) {
    return undefined
  }
  assertProfileStateRepairRevision(db, revision)
  const intact = new Map<string, unknown>()
  const damaged = new Set<string>()
  // Undefined: history is stored in its document row. Null: absent, or damaged.
  let normalizedRuns: ProfileStateParsedDocument | null | undefined
  try {
    normalizedRuns = readProfileStateAutomationRunsDocument(db, revision, 'parsed')
  } catch (error) {
    if (!(error instanceof ProfileStateDocumentCorruptionError)) {
      throw error
    }
    damaged.add('automationRuns')
    normalizedRuns = null
  }
  const rows = db
    .prepare(
      `SELECT domain, payload, domain_version, revision, updated_at, content_hash
       FROM profile_state_documents ORDER BY rowid`
    )
    .iterate()
  for (const row of rows) {
    const domain = isRecord(row) && typeof row.domain === 'string' ? row.domain : undefined
    let document: ReturnType<typeof validateProfileStateDocumentRow>
    try {
      document = validateProfileStateDocumentRow(row, { retainParsedValue: true })
    } catch (error) {
      if (!(error instanceof ProfileStateDocumentCorruptionError) || domain === undefined) {
        throw error
      }
      damaged.add(domain)
      continue
    }
    if (document.domain === 'automationRuns' && normalizedRuns !== undefined) {
      // Normalized history is authoritative; its document row is only a 'null' placeholder.
      if (document.payload !== 'null') {
        damaged.add('automationRuns')
      }
      continue
    }
    intact.set(document.domain, document.value)
  }
  if (normalizedRuns && !damaged.has('automationRuns')) {
    intact.set('automationRuns', normalizedRuns.value)
  }
  return { revision, intact, damaged }
}
