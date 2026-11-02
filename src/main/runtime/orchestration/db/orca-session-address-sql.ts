import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../shared/orca-session-address'

/** Format bare ids as session addresses (NULL stays NULL); never strip addresses and risk matching handles or Runs. */
export function orcaSessionAddressSql(orcaSessionIdSql: string): string {
  return `('${ORCA_SESSION_ADDRESS_PREFIX}' || ${orcaSessionIdSql})`
}
