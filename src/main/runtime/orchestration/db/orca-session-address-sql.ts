import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../shared/orca-session-address-prefix'

/** Format bare ids as session addresses (NULL stays NULL); never strip addresses and risk matching handles or Runs. */
export function orcaSessionAddressSql(orcaSessionIdSql: string): string {
  return `('${ORCA_SESSION_ADDRESS_PREFIX}' || ${orcaSessionIdSql})`
}

/** The bare id a session address names, NULL for anything else; comparing ids lets the id index serve. */
export function orcaSessionIdOfAddressSql(addressSql: string): string {
  return `(CASE WHEN substr(${addressSql}, 1, ${ORCA_SESSION_ADDRESS_PREFIX.length}) = '${ORCA_SESSION_ADDRESS_PREFIX}'
    THEN substr(${addressSql}, ${ORCA_SESSION_ADDRESS_PREFIX.length + 1}) END)`
}
