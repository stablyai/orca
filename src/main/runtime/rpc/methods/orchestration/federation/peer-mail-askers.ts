// Whom peer mail's sending turn acts for, as the receiving Orca reads it.
import * as z from 'zod'
import { distinctAskers, type BotRequestAsker } from '../../../../../../shared/bots/bot-acts-for'
import { CONNECTOR_SOURCES } from '../../../../../../shared/connectors/external-conversation-link'
import { CONNECTOR_ASKER_PLACE_KINDS } from '../../../../../../shared/connector-asker-contract'

const CarriedAsker = z.discriminatedUnion('kind', [
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

/** The askers the sender carried, each one this Orca can't read as someone it can't name. */
export function readPeerMailAskers(carried: readonly unknown[]): BotRequestAsker[] {
  return distinctAskers(
    carried.map(
      (asker): BotRequestAsker => CarriedAsker.safeParse(asker).data ?? { kind: 'unknown' }
    )
  )
}
