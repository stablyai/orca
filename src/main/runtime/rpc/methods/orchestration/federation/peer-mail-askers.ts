// Whom peer mail's sending turn acts for, as the receiving Orca reads it.
import * as z from 'zod'
import { lazyZodSchema } from '../../../../../../shared/schema/lazy-zod-schema'
import { distinctAskers, type BotRequestAsker } from '../../../../../../shared/bots/bot-acts-for'
import type { ConnectorSource } from '../../../../../../shared/connectors/external-conversation-link'
import { CONNECTOR_ASKER_PLACE_KINDS } from '../../../../../../shared/connector-asker-contract'

// A person is read by their user id; a field or value a newer Orca added or changed is left out, never
// the person, so their ask is never read as the owner's alone.
const CarriedPerson = lazyZodSchema(() =>
  z.object({
    // A service name, never a delimiter that could merge two people when askers are deduped.
    source: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    userId: z.string().min(1).max(128),
    name: z.string().min(1).max(200).optional().catch(undefined),
    workspaceId: z.string().min(1).max(128).nullable().catch(null),
    role: z.enum(['owner', 'member']).nullable().catch(null),
    placeKind: z.enum(CONNECTOR_ASKER_PLACE_KINDS).optional().catch(undefined)
  })
)

function readAsker(carried: unknown): BotRequestAsker[] {
  const kind =
    typeof carried === 'object' && carried !== null && 'kind' in carried ? carried.kind : null
  if (kind === 'owner' || kind === 'unknown') {
    return [{ kind }]
  }
  const person = CarriedPerson.safeParse(carried).data
  if (!person) {
    return []
  }
  const { name, placeKind, ...identity } = person
  return [
    {
      ...identity,
      kind: 'person',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a source a newer Orca added keeps the person; its label falls back to the raw source.
      source: identity.source as ConnectorSource,
      ...(name ? { name } : {}),
      ...(placeKind ? { placeKind } : {})
    }
  ]
}

/** The askers the sender carried. Only an entry with no readable identity is dropped, so the
 *  request reads as it did before askers were carried. */
export function readPeerMailAskers(carried: readonly unknown[]): BotRequestAsker[] {
  return distinctAskers(carried.flatMap(readAsker))
}
