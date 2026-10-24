/**
 * The journal of a UNC Windows-drive project conversion (D1c): `wsl-drive-unc-conversions/<id>.json`
 * beside the profile. Written once the scope's panes are asleep, and read at the next startup,
 * before the profile loads, which runs the conversion. Its own directory, so an older build never
 * reads it as a move.
 *
 * - `prepared`: nothing outside the journal changed yet; a failed profile rewrite drops the record.
 * - `profile-rewritten`: the profile names the drive paths; the other stores only go forward.
 */
import { isRecord } from '../../shared/orcad-migration/orcad-migration-manifest-fields'
import { createMigrationJournalDirectory } from '../persistence/migrating-orcad-catalog/migration-journal-directory'

export const WSL_DRIVE_UNC_CONVERSION_PHASES = ['prepared', 'profile-rewritten'] as const
export type WslDriveUncConversionPhase = (typeof WSL_DRIVE_UNC_CONVERSION_PHASES)[number]

export type WslDriveUncConversion = {
  version: 1
  migrationId: string
  distro: string
  repoIds: string[]
  folderWorkspaceIds: string[]
  /** The converting projects' folders, as UNC paths, for a spawn that names no workspace. */
  rootPaths: string[]
  phase: WslDriveUncConversionPhase
  /** Old → new worktree ids, from the profile rewrite; empty before it. */
  worktreeIds: [string, string][]
  /** The stores outside the profile already converted, so a resumed run skips them. */
  rewrittenStores: string[]
  createdAt: string
  updatedAt: string
}

export class WslDriveUncConversionJournalUnreadableError extends Error {
  constructor(detail: string) {
    super(`The Windows-drive conversion journal cannot be read: ${detail}`)
    this.name = 'WslDriveUncConversionJournalUnreadableError'
  }
}

const changeListeners = new Set<(userDataPath: string) => void>()

/** Runs after every durable write or removal; returns the unsubscribe. */
export function onWslDriveUncConversionJournalChange(
  listener: (userDataPath: string) => void
): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

const journals = createMigrationJournalDirectory({
  directoryName: 'wsl-drive-unc-conversions',
  maxFileBytes: 4 * 1024 * 1024,
  parse: parseWslDriveUncConversion,
  unreadable: (detail) => new WslDriveUncConversionJournalUnreadableError(detail),
  onChange: (userDataPath) => {
    for (const listener of changeListeners) {
      listener(userDataPath)
    }
  }
})

export function listWslDriveUncConversions(userDataPath: string): WslDriveUncConversion[] {
  return journals.list(userDataPath).map((record) => structuredClone(record))
}

export function writeWslDriveUncConversion(
  userDataPath: string,
  record: WslDriveUncConversion
): void {
  journals.write(userDataPath, record)
}

export function removeWslDriveUncConversion(userDataPath: string, migrationId: string): void {
  journals.remove(userDataPath, migrationId)
}

function parseWslDriveUncConversion(value: unknown): WslDriveUncConversion {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isText(value.migrationId) ||
    !isText(value.distro) ||
    !isTextList(value.repoIds) ||
    !isTextList(value.folderWorkspaceIds) ||
    !isTextList(value.rootPaths) ||
    !WSL_DRIVE_UNC_CONVERSION_PHASES.some((phase) => phase === value.phase) ||
    !Array.isArray(value.worktreeIds) ||
    !value.worktreeIds.every(
      (pair) => Array.isArray(pair) && pair.length === 2 && pair.every(isText)
    ) ||
    !isTextList(value.rewrittenStores) ||
    !isText(value.createdAt) ||
    !isText(value.updatedAt)
  ) {
    throw new Error('wsl_drive_unc_conversion_malformed')
  }
  return {
    version: 1,
    migrationId: value.migrationId,
    distro: value.distro,
    repoIds: [...value.repoIds],
    folderWorkspaceIds: [...value.folderWorkspaceIds],
    rootPaths: [...value.rootPaths],
    phase: WSL_DRIVE_UNC_CONVERSION_PHASES.find((phase) => phase === value.phase) ?? 'prepared',
    worktreeIds: value.worktreeIds.map((pair: [string, string]) => [pair[0], pair[1]]),
    rewrittenStores: [...value.rewrittenStores],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  }
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isText)
}
