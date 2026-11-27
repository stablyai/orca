// Whom peer mail's sending turn acts for, as the receiving Orca reads it.
import * as z from 'zod'
import { lazyZodSchema } from '../../../../../../shared/schema/lazy-zod-schema'
import { distinctAskers, type BotRequestAsker } from '../../../../../../shared/bots/bot-acts-for'
import { CONNECTOR_SOURCES } from '../../../../../../shared/connectors/external-conversation-link'
import { CONNECTOR_ASKER_PLACE_KINDS } from '../../../../../../shared/connector-asker-contract'

const CarriedAsker = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('owner') }),
    z.object({ kind: z.literal('unknown') }),
    z.object({
      kind: z.literal('person'),
      source: z.enum(CONNECTOR_SOURCES),
      userId: z.string().min(1).max(128),
      name: z.string().min(1).max(200).optional(),
      workspaceId: z.string().min(1).max(128).nullable(),
      role: z.enum(['owner', 'member']).nullable(),
      placeKind: z.enum(CONNECTOR_ASKER_PLACE_KINDS).optional()
    })
  ])
)

/** The askers the sender carried that this Orca can read; one it can't (a newer Orca's) is
 *  dropped, so the request reads as it did before askers were carried. */
export function readPeerMailAskers(carried: readonly unknown[]): BotRequestAsker[] {
  return distinctAskers(carried.flatMap((asker) => CarriedAsker.safeParse(asker).data ?? []))
}
