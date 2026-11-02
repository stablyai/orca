import { orcaSessionAddressSql } from '../orca-session-address-sql'
import type { OrcaSessionId } from '../../../../../shared/orca-session-address'
import type { RunRow } from '../../types'

type RunCoordinatorOrcaSessionFields = Pick<
  RunRow,
  'coordinator_orca_session_id' | 'coordinator_orca_session_id_generation' | 'consumer_generation'
>

/** Count a coordinator session id only at its stamped consumer generation; older writers bump generation without clearing it. */
export function currentRunCoordinatorOrcaSessionId(
  run: RunCoordinatorOrcaSessionFields
): OrcaSessionId | null {
  return run.coordinator_orca_session_id_generation === run.consumer_generation
    ? run.coordinator_orca_session_id
    : null
}

/** The same rule in SQL, for a `runs` row named `row` (a table name, alias, or `NEW`). */
export function currentRunCoordinatorOrcaSessionIdSql(row: string): string {
  return `(CASE WHEN ${row}.coordinator_orca_session_id_generation = ${row}.consumer_generation
    THEN ${row}.coordinator_orca_session_id END)`
}

/** The coordinator's `orca_session_id:<id>` address in SQL; NULL when it has no current Orca session id. */
export function currentRunCoordinatorSessionAddressSql(row: string): string {
  return orcaSessionAddressSql(currentRunCoordinatorOrcaSessionIdSql(row))
}
