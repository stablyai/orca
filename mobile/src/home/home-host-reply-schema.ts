import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// The Home card's two per-host reads. Checked against `stats.summary`
// (src/main/runtime/rpc/methods/stats.ts, `runtime.getStatsSummary() ?? {}`) and `accounts.list`
// (src/main/runtime/rpc/methods/accounts.ts, `runtime.getAccountsSnapshot()`).

/**
 * One host's lifetime-usage row.
 *
 * Nothing here is required, not even the object, and the schema is total for the same reason.
 * `totalHomeStats` is the reader and it guards the row itself
 * (`if (!host || typeof host !== 'object') continue`, home-stats-total.ts:40), so requiring an
 * object would buy nothing at the read and would cost the row upstream: the refusal reaches
 * `fetchMobileHomeStats`'s `.catch`, the per-host slot is never written, `hostIds.filter` finds no
 * host, `totalHomeStats` returns null and the header draws no stats row where main drew a zeroed
 * one. `.nullish()` alone only covered null and absent; a non-object still refused, which is the
 * same regression for a reply main tolerated, so the catch makes any unreadable row decode as
 * absent and land in the slot the total already skips.
 *
 * `firstEventAt` keeps its explicit `null`: that is the host's "no events yet", and the total
 * distinguishes it from a number when taking the minimum.
 */
export const homeHostStatsSchema = z
  .looseObject({
    totalAgentsSpawned: salvagedOptional('totalAgentsSpawned', z.number()),
    totalPRsCreated: salvagedOptional('totalPRsCreated', z.number()),
    totalAgentTimeMs: salvagedOptional('totalAgentTimeMs', z.number()),
    firstEventAt: salvagedOptional('firstEventAt', z.number().nullable())
  })
  .nullish()
  .catch(undefined)

/**
 * One host's accounts snapshot, forwarded whole.
 *
 * `decodeAccountsSnapshot` is the validator, at the call site, and it is shared with the account
 * pane and the Codex reset sheet; declaring the provider blocks here would give the same reply two
 * decoders that could disagree about a row. The forward is opaque on purpose, not a member left
 * unchecked.
 */
export const homeHostAccountsSchema = z.unknown()
