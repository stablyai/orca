import { z } from 'zod'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'

export const piRpcModelSchema = lazyZodSchema(() =>
  z.looseObject({
    id: z.string(),
    provider: z.string(),
    name: z.string().optional(),
    contextWindow: z.number().nonnegative().optional(),
    reasoning: z.boolean().optional(),
    input: z.array(z.string()).optional()
  })
)
export type PiRpcModel = z.infer<typeof piRpcModelSchema>
