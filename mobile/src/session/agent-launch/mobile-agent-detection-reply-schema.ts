import * as z from 'zod'
import { salvagingArray } from '../../../../src/shared/zod-salvage'

// Repo lookup needs only id; preserve remaining fields for each consumer’s own projection.
export const runtimeRepoListSchema = z
  .looseObject({ repos: salvagingArray(z.looseObject({ id: z.string() })) })
  .transform((reply) => reply.repos)

// Require the array before option construction spreads it; isMobileTuiAgent filters individual entries.
export const detectedAgentsSchema = z.array(z.unknown())

/** `preflight.refreshAgents` wraps the same list with PATH diagnostics the drawer never reads. */
export const refreshedAgentsSchema = z
  .looseObject({ agents: detectedAgentsSchema })
  .transform((reply) => reply.agents)
