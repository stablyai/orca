import { existsSync, readFileSync } from 'node:fs'
import {
  ProfileStateRecoveryCommandError,
  type ProfileStateExportsResult,
  type ProfileStateRecoverySelector
} from '../../../shared/profile-state-recovery-command'
import { profileStateJsonExportPath } from './legacy-json/profile-state-export-path'
import { openProfileStateDatabaseReadOnly } from './profile-state-database'
import { withProfileStateReadSnapshot } from './profile-state-read-snapshot'
import { readProfileStateRevision } from './profile-state-revision'
import { parseProfileStateRoot } from './profile-state-document-validation'

export type DomainDiff = {
  /** Domains in the live profile that are absent from the source (would be lost). */
  lost: readonly string[]
  /** Domains in both whose payload would change. */
  changed: readonly string[]
  /** Domains in the source that are absent from the live profile (would be added). */
  added: readonly string[]
}

export type PreviewRollbackTarget = {
  /** Backup id or JSON revision the preview was run against. */
  source: string
  /** Revision the live profile would land on. */
  targetRevision: number
  /** Revision the live profile is at now. */
  liveRevision: number
  diff: DomainDiff
  /** True when the selector is a JSON export (payloads are not byte-comparable
   *  to the live SQLite rows, so `changed` reports only added/lost). */
  payloadsUncomparable?: boolean
}

/**
 * Preview a rollback without writing anything: report which domains would be
 * lost, changed, or added if the selected backup or JSON export were restored.
 * Read-only; the live database and the source artifact are opened read-only.
 *
 * For a SQLite backup the live rows are diffed byte-for-byte against the
 * backup's rows, so `changed` lists domains whose payload would actually
 * differ. For a JSON export the export is compared at the domain-set level
 * only, because a JSON export is a canonical re-serialization of the database
 * at that revision and its byte payloads are not comparable to the live rows;
 * `payloadsUncomparable` is set in that case.
 */
export function previewProfileStateRollback(
  result: ProfileStateExportsResult,
  selector: ProfileStateRecoverySelector
): PreviewRollbackTarget {
  if (selector.kind === 'sqlite') {
    return previewSqliteBackup(result, selector.backupId)
  }
  if (selector.kind === 'json') {
    return previewJsonExport(result, selector.revision)
  }
  throw new ProfileStateRecoveryCommandError(
    'invalid_argument',
    `Profile-state preview is available only for --backup and --revision selectors, not ${selector.kind}.`
  )
}

function liveDomainIndex(result: ProfileStateExportsResult) {
  const opened = openProfileStateDatabaseReadOnly(result.databaseFile, result.profileId)
  try {
    return withProfileStateReadSnapshot(opened.db, () => {
      const revision = readProfileStateRevision(opened.db)
      const rows = new Map<
        string,
        string
      >(
        opened.db
          .prepare('SELECT domain, payload FROM profile_state_documents')
          .all()
          .filter((r) => typeof (r as { domain: unknown }).domain === 'string')
          .map((r) => [
            (r as { domain: string; payload: string }).domain,
            (r as { payload: string }).payload
          ])
      )
      return { revision, rows }
    })
  } finally {
    opened.db.close()
  }
}

function diffDomains(
  live: Map<string, string>,
  source: Map<string, string>
): DomainDiff {
  const lost: string[] = []
  const changed: string[] = []
  const added: string[] = []
  for (const domain of live.keys()) {
    if (!source.has(domain)) {
      lost.push(domain)
    } else if (live.get(domain) !== source.get(domain)) {
      changed.push(domain)
    }
  }
  for (const domain of source.keys()) {
    if (!live.has(domain)) {
      added.push(domain)
    }
  }
  return { lost: lost.sort(), changed: changed.sort(), added: added.sort() }
}

function previewSqliteBackup(result: ProfileStateExportsResult, backupId: string): PreviewRollbackTarget {
  const backup = result.backups.find((entry) => entry.id === backupId)
  if (!backup) {
    throw new ProfileStateRecoveryCommandError(
      'invalid_argument',
      `Profile-state backup ${backupId} is unavailable. Use profile state exports to inspect retained backups.`
    )
  }
  const opened = openProfileStateDatabaseReadOnly(backup.path, result.profileId)
  try {
    const targetRevision = readProfileStateRevision(opened.db)
    const sourceRows = new Map<string, string>(
      opened.db
        .prepare('SELECT domain, payload FROM profile_state_documents')
        .all()
        .filter((r) => typeof (r as { domain: unknown }).domain === 'string')
        .map((r) => [
          (r as { domain: string; payload: string }).domain,
          (r as { payload: string }).payload
        ])
    )
    const live = liveDomainIndex(result)
    const diff = diffDomains(live.rows, sourceRows)
    return {
      source: backupId,
      targetRevision,
      liveRevision: live.revision,
      diff
    }
  } finally {
    opened.db.close()
  }
}

function previewJsonExport(
  result: ProfileStateExportsResult,
  revision: number
): PreviewRollbackTarget {
  const exportPath = profileStateJsonExportPath(result.dataFile, revision)
  if (!result.exportPaths.includes(exportPath) || !existsSync(exportPath)) {
    throw new ProfileStateRecoveryCommandError(
      'invalid_argument',
      `Profile-state export revision ${revision} is unavailable. Use profile state exports to inspect retained revisions.`
    )
  }
  const raw = readFileSync(exportPath, 'utf8')
  let parsedRoot: Record<string, unknown>
  try {
    // Validate with the same root validator the restore path uses; an export
    // that cannot be restored must not be previewed as a usable target.
    parsedRoot = parseProfileStateRoot(raw)
  } catch (error) {
    throw new ProfileStateRecoveryCommandError(
      'invalid_argument',
      `Profile-state export revision ${revision} is invalid and cannot be previewed or restored: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  const sourceDomains = new Map<string, string>()
  for (const key of Object.keys(parsedRoot)) {
    sourceDomains.set(key, JSON.stringify(parsedRoot[key]))
  }
  const live = liveDomainIndex(result)
  const diff = domainSetDiff(live.rows, sourceDomains)
  return {
    source: String(revision),
    targetRevision: revision,
    liveRevision: live.revision,
    diff,
    payloadsUncomparable: true
  }
}

function domainSetDiff(live: Map<string, string>, source: Map<string, string>): DomainDiff {
  const lost: string[] = []
  const added: string[] = []
  for (const domain of live.keys()) {
    if (!source.has(domain)) {
      lost.push(domain)
    }
  }
  for (const domain of source.keys()) {
    if (!live.has(domain)) {
      added.push(domain)
    }
  }
  return { lost: lost.sort(), changed: [], added: added.sort() }
}
