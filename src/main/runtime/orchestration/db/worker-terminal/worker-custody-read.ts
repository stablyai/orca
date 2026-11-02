import type { WorkerTerminalResourceRow } from '../../worker-terminal-ownership'
import type { DispatchContextRow } from '../../types'
import { parseWorkerTerminalPriorOwnerIds } from '../pane-key-match'
export type CustodyResource = Pick<
  WorkerTerminalResourceRow,
  'id' | 'owner_dispatch_id' | 'prior_owner_dispatch_ids'
>
export type CustodyDispatch = Pick<DispatchContextRow, 'id' | 'process_incarnation' | 'host_scope'>
export type CustodyReaders = {
  owned: (id: string) => CustodyResource | undefined
  cohort: (incarnation: string, host: string | null) => CustodyResource[]
}

type OwnerHistory = Map<string, string | undefined>

/** For one caller check: who held a Dispatch's exact terminal process right before it, from saved custody only. Each
 *  owner history and identity cohort is read and decoded at most once per check; it is evidence, never permission, and
 *  goes when the check does. */
export function createPreviousCustodianLookup(
  read: CustodyReaders
): (dispatch: CustodyDispatch) => string | undefined {
  const histories = new Map<string, OwnerHistory | null>()
  // Per exact process: each former holder's one custody row, or null when several rows name it.
  const cohorts = new Map<string, Map<string, CustodyResource | null>>()
  // Each holder's predecessor in the row's ordered owners; unreadable or repeating history proves nothing.
  const historyOf = (resource: CustodyResource) => {
    if (!histories.has(resource.id)) {
      const prior = parseWorkerTerminalPriorOwnerIds(resource.prior_owner_dispatch_ids)
      const owners = prior && [...prior, resource.owner_dispatch_id]
      const previous = owners && new Map(owners.map((owner, index) => [owner, owners[index - 1]]))
      histories.set(resource.id, previous?.size === owners?.length ? previous : null)
    }
    return histories.get(resource.id)
  }
  const cohortOf = (incarnation: string, host: string | null) => {
    const key = JSON.stringify([incarnation, host])
    let holders = cohorts.get(key)
    if (!holders) {
      holders = new Map()
      const rows = read.cohort(incarnation, host)
      for (const row of rows) {
        for (const holder of historyOf(row)?.keys() ?? []) {
          holders.set(holder, holders.has(holder) ? null : row)
        }
      }
      cohorts.set(key, holders)
    }
    return holders
  }
  return (dispatch) => {
    const resource =
      read.owned(dispatch.id) ??
      (dispatch.process_incarnation
        ? cohortOf(dispatch.process_incarnation, dispatch.host_scope).get(dispatch.id)
        : undefined)
    return resource ? historyOf(resource)?.get(dispatch.id) : undefined
  }
}
