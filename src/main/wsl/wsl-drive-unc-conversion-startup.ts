/**
 * Runs a journaled UNC Windows-drive conversion (D1c) at startup, before the profile loads, so the
 * window's first read already sees the drive paths. The profile is rewritten in one transaction,
 * which is the commit point: a failure before it drops the journal and changes nothing, and after
 * it each other store only goes forward, retried at the next startup.
 */
import {
  prepareProfileProjectDomainChanges,
  type ProfileProjectDomainChanges
} from '../orca-profiles/profile-project-domain-changes'
import {
  readProfileProjectTransferState,
  writeProfileProjectDomainChanges
} from '../orca-profiles/profile-project-domain-state'
import { migrateProfileProjectTransferParticipant } from '../orca-profiles/profile-project-transfer-migration'
import {
  listWslDriveUncConversions,
  removeWslDriveUncConversion,
  writeWslDriveUncConversion,
  type WslDriveUncConversion
} from './wsl-drive-unc-conversion-journal'
import {
  wslDriveUncConversionStores,
  type WslDriveUncConversionStore
} from './wsl-drive-unc-conversion-stores'
import { wslHostsGateOpen } from './wsl-host-gate'
import { getHistoryRoot, listWslHistoryRoots } from '../terminal-history-paths'
import { orchestrationDbFile } from '../runtime/orchestration/db/orchestration-db-file'
import { journalDatabasePath } from '../native-chat/agent-session-journal/journal-host-database'
import { rewriteWslDriveUncState } from './wsl-drive-unc-state-rewrite'
import { WSL_DRIVE_UNC_STATE_DISPOSITIONS } from '../../shared/wsl-drive-unc-state-dispositions'

export type WslDriveUncConversionStartupDeps = {
  /** Where the journal lives. */
  userDataPath: string
  /** Where the profiles live. */
  profileUserDataPath: string
  profileId: string
  stores: readonly WslDriveUncConversionStore[]
  now?: () => Date
}

export type WslDriveUncConversionOutcome =
  | { migrationId: string; outcome: 'converted'; repoIds: string[]; folderWorkspaceIds: string[] }
  /** The profile could not be rewritten; nothing changed, and the panes stay asleep. */
  | { migrationId: string; outcome: 'rolled-back'; detail: string }
  /** The profile is converted; `store` failed and retries at the next startup. */
  | { migrationId: string; outcome: 'resuming'; store: string; detail: string }

export function runWslDriveUncConversionsAtStartup(
  deps: WslDriveUncConversionStartupDeps
): WslDriveUncConversionOutcome[] {
  return listWslDriveUncConversions(deps.userDataPath).map((record) => runOne(deps, record))
}

function runOne(
  deps: WslDriveUncConversionStartupDeps,
  initial: WslDriveUncConversion
): WslDriveUncConversionOutcome {
  const { migrationId } = initial
  let record = initial
  if (record.phase === 'prepared') {
    try {
      record = rewriteProfile(deps, record)
    } catch (error) {
      removeWslDriveUncConversion(deps.userDataPath, migrationId)
      return { migrationId, outcome: 'rolled-back', detail: describe(error) }
    }
  }
  const worktreeIds = new Map(record.worktreeIds)
  for (const store of deps.stores) {
    if (record.rewrittenStores.includes(store.id)) {
      continue
    }
    try {
      store.run(worktreeIds)
    } catch (error) {
      return { migrationId, outcome: 'resuming', store: store.id, detail: describe(error) }
    }
    record = update(deps, record, { rewrittenStores: [...record.rewrittenStores, store.id] })
  }
  removeWslDriveUncConversion(deps.userDataPath, migrationId)
  return {
    migrationId,
    outcome: 'converted',
    repoIds: record.repoIds,
    folderWorkspaceIds: record.folderWorkspaceIds
  }
}

/**
 * Idempotent: a profile already rewritten (a crash after its commit) rewrites to itself, and the
 * id map was journaled before the commit, so the other stores still get it.
 */
function rewriteProfile(
  deps: WslDriveUncConversionStartupDeps,
  record: WslDriveUncConversion
): WslDriveUncConversion {
  const read = readProfileProjectTransferState(deps.profileId, deps.profileUserDataPath)
  const snapshot =
    read.revision === undefined
      ? migrateProfileProjectTransferParticipant(deps.profileId, deps.profileUserDataPath, read)
      : read
  if (snapshot.revision === undefined || !snapshot.documents) {
    throw new Error('wsl_drive_unc_profile_not_sqlite')
  }
  const { state, worktreeIds } = rewriteWslDriveUncState(snapshot.state, record)
  const known = new Map(record.worktreeIds)
  const merged = new Map([...known, ...worktreeIds])
  let current = record
  if (merged.size !== known.size) {
    current = update(deps, current, { worktreeIds: [...merged] })
  }
  // Only the rewritten fields, from their stored documents: nothing else is reserialized.
  const values: Record<string, unknown> = Object.fromEntries(
    snapshot.documents.map((document) => [document.domain, document.value])
  )
  for (const field of Object.keys(WSL_DRIVE_UNC_STATE_DISPOSITIONS)) {
    if (isStateKey(field, state) && state[field] !== snapshot.state[field]) {
      values[field] = state[field]
    }
  }
  const changes: ProfileProjectDomainChanges = prepareProfileProjectDomainChanges(
    snapshot.revision,
    snapshot.documents,
    values
  )
  if (changes.replacements.length > 0) {
    writeProfileProjectDomainChanges(deps.profileId, deps.profileUserDataPath, changes)
  }
  return update(deps, current, { phase: 'profile-rewritten' })
}

function isStateKey<T extends object>(field: string, state: T): field is Extract<keyof T, string> {
  return Object.hasOwn(state, field)
}

function update(
  deps: WslDriveUncConversionStartupDeps,
  record: WslDriveUncConversion,
  changes: Partial<Pick<WslDriveUncConversion, 'phase' | 'worktreeIds' | 'rewrittenStores'>>
): WslDriveUncConversion {
  const next = { ...record, ...changes, updatedAt: (deps.now?.() ?? new Date()).toISOString() }
  writeWslDriveUncConversion(deps.userDataPath, next)
  return next
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let lastOutcomes: WslDriveUncConversionOutcome[] = []

/** What this run's startup did, for the window to report. */
export function lastWslDriveUncConversionOutcomes(): WslDriveUncConversionOutcome[] {
  return [...lastOutcomes]
}

/**
 * Startup, before the profile store opens: with nothing journaled it only lists one directory.
 * Never throws; a conversion it can't finish stays journaled for the next startup.
 */
export function runPendingWslDriveUncConversions(paths: {
  userDataPath: string
  profileUserDataPath: string
  profileId: string
}): void {
  if (process.platform !== 'win32' || !wslHostsGateOpen()) {
    return
  }
  try {
    lastOutcomes = runWslDriveUncConversionsAtStartup({
      ...paths,
      stores: wslDriveUncConversionStores({
        daemonHistoryDir: getHistoryRoot(),
        shellHistoryRoots: [getHistoryRoot(), ...listWslHistoryRoots()],
        orchestrationDatabasePath: orchestrationDbFile(paths.userDataPath),
        chatJournalDatabasePath: journalDatabasePath(paths.profileUserDataPath)
      })
    })
  } catch (error) {
    console.warn('[wsl-drive-unc] Could not run a pending conversion:', describe(error))
  }
  for (const outcome of lastOutcomes) {
    if (outcome.outcome !== 'converted') {
      console.warn('[wsl-drive-unc] Conversion did not finish:', outcome)
    }
  }
}
