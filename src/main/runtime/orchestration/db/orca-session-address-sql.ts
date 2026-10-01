import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../shared/orca-session-address'

/**
 * The `session:<id>` address of a bare Orca session id column or expression, NULL when it is NULL.
 * The only way SQL compares a stored id with a mail address: the id side is formatted, never the
 * address side stripped, so a handle or `run:` address can never equal a bare id.
 */
export function orcaSessionAddressSql(orcaSessionIdSql: string): string {
  return `('${ORCA_SESSION_ADDRESS_PREFIX}' || ${orcaSessionIdSql})`
}
