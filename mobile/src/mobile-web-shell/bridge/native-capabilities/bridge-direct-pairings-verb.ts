import * as z from 'zod'

// Read-only: the installations this phone pairs with directly, so a page can hide a desktop's relayed
// copy of one. An older shell refuses the verb and the page shows every relayed server, as before.
export const BRIDGE_DIRECT_PAIRINGS_VERB = 'native.pairings.installations'

export const directPairingsParamsSchema = z.strictObject({})

export const directPairingsResultSchema = z.strictObject({
  installationIds: z.array(z.string().min(1).max(256)).max(256)
})
