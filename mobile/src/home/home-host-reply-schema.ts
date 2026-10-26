import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Decode any unreadable row as absent: totalHomeStats skips it, but seating the host slot preserves the zeroed header instead of removing it.
// Keep firstEventAt:null as the host’s explicit no-events state when computing the minimum.
export const homeHostStatsSchema = z
  .looseObject({
    totalAgentsSpawned: salvagedOptional('totalAgentsSpawned', z.number()),
    totalPRsCreated: salvagedOptional('totalPRsCreated', z.number()),
    totalAgentTimeMs: salvagedOptional('totalAgentTimeMs', z.number()),
    firstEventAt: salvagedOptional('firstEventAt', z.number().nullable())
  })
  .nullish()
  .catch(undefined)

// Forward accounts opaquely; decodeAccountsSnapshot already validates them at the call site and is shared with the account pane and reset sheet.
export const homeHostAccountsSchema = z.unknown()
