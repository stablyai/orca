import * as z from 'zod'
import { salvagingArray } from '../../../../src/shared/validation/zod-salvage'

// Repo lookup needs only id; preserve remaining fields for each consumer’s own projection.
export const runtimeRepoListSchema = z
  .looseObject({ repos: salvagingArray(z.looseObject({ id: z.string() })) })
  .transform((reply) => reply.repos)

const agentListSchema = z.array(z.unknown())

export const refreshedAgentsSchema = z.object({
  agents: agentListSchema,
  incomplete: z.boolean().optional(),
  afterPublication: z.number().int().nonnegative().optional()
})

// Older hosts and remote detection return the list alone.
export const detectedAgentsSchema = z.union([
  refreshedAgentsSchema,
  agentListSchema.transform((agents): z.output<typeof refreshedAgentsSchema> => ({ agents }))
])
