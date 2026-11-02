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

/** Under `~/.orca-remote`: held by one snapshot capture, restore or clear at a time. */
export const ORCAD_STATE_MUTATION_LOCK_DIRNAME = 'orcad-state-mutation.lock'

/**
 * How often a running mutation refreshes the activation fence's mtime. Why: the fence goes
 * stale by age (INSTALL_LOCK_STALE_MS), and a mutation may outlast that, so a live run keeps
 * it fresh while a dead one stops within a beat.
 */
export const ORCAD_STATE_MUTATION_FENCE_HEARTBEAT_SECONDS = 60
/** How long a lock an exited desktop process left must sit untouched before it is reclaimed. */
export const ORCAD_EXITED_OWN_LOCK_QUIET_SECONDS = 3 * ORCAD_STATE_MUTATION_FENCE_HEARTBEAT_SECONDS

/** A state mutation found another still running, so it did nothing. */
export const ORCAD_STATE_MUTATION_BUSY = 'STATE_MUTATION_BUSY'
/** The host-side deadline killed a state mutation part way through. */
export const ORCAD_STATE_MUTATION_DEADLINE = 'STATE_MUTATION_DEADLINE'

/** Windows keeps the snapshot as a directory copy, where POSIX keeps `state.tar`. */
export const ORCAD_WINDOWS_SNAPSHOT_STATE_DIRNAME = 'state'
