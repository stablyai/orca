import * as z from 'zod'

export const sessionProjectNameSchema = z
  .looseObject({ repo: z.looseObject({ displayName: z.string() }) })
  .transform((reply) => reply.repo.displayName.trim())
