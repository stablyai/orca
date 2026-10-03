/** What the pre-activation snapshot holds; shared by the POSIX commands and the Windows host script. */

/**
 * Root-relative paths a rollback needs restored. Everything else under the data root is
 * either regenerable, or owned by a process that survives the rollback.
 */
export const ORCAD_SNAPSHOT_MEMBERS = [
  'orca-profile-index.json',
  // Pre-profiles layout; still read as a migration source.
  'orca-data.json',
  'profiles',
  // Cross-profile SQLite moves must survive an orcad rollback too.
  'profile-move-intents'
] as const

/** Never captured and never restored — see `orcad-state-snapshot.ts`. */
export const ORCAD_SNAPSHOT_EXCLUDED = ['daemon', 'logs'] as const

export const ORCAD_STATE_RESTORE_STAGE_DIRNAME = '.orcad-state-restore-stage'

/** Windows keeps the snapshot as a directory copy, where POSIX keeps `state.tar`. */
export const ORCAD_WINDOWS_SNAPSHOT_STATE_DIRNAME = 'state'
