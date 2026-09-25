import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../shared/orca-session-address'
import type { RunRow } from '../../types'

type RunCoordinatorOrcaSessionFields = Pick<
  RunRow,
  'coordinator_orca_session_id' | 'coordinator_orca_session_id_generation' | 'consumer_generation'
>

/**
 * A Run coordinator's Orca session id counts only at the `consumer_generation` it was written at.
 * Every write that rebinds or unbinds a Run bumps that generation, including one from a binary that
 * predates the column, so an id such a write leaves behind stops counting with nothing to clear it.
 */
export function currentRunCoordinatorOrcaSessionId(
  run: RunCoordinatorOrcaSessionFields
): string | null {
  return run.coordinator_orca_session_id_generation === run.consumer_generation
    ? run.coordinator_orca_session_id
    : null
}

/** The same rule in SQL, for a `runs` row named `row` (a table name, alias, or `NEW`). */
export function currentRunCoordinatorOrcaSessionIdSql(row: string): string {
  return `(CASE WHEN ${row}.coordinator_orca_session_id_generation = ${row}.consumer_generation
    THEN ${row}.coordinator_orca_session_id END)`
}

/** The coordinator's `session:<id>` address in SQL; NULL when it has no current Orca session id. */
export function currentRunCoordinatorSessionAddressSql(row: string): string {
  return `('${ORCA_SESSION_ADDRESS_PREFIX}' || ${currentRunCoordinatorOrcaSessionIdSql(row)})`
}
