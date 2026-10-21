import { z } from 'zod'

const windowSchema = z.object({
  usedPercent: z.unknown().optional(),
  windowDurationMins: z.unknown().optional(),
  resetsAt: z.unknown().optional()
})

const responseSchema = z.object({
  id: z.number(),
  error: z.object({ message: z.string() }).nullish().catch(undefined),
  result: z
    .object({
      rateLimits: z
        .object({
          primary: windowSchema.nullish().catch(undefined),
          secondary: windowSchema.nullish().catch(undefined),
          credits: z
            .object({
              hasCredits: z.boolean().optional().catch(undefined),
              unlimited: z.boolean().optional().catch(undefined),
              balance: z.union([z.string(), z.number()]).optional().catch(undefined)
            })
            .nullish()
            .catch(undefined)
        })
        .nullish()
        .catch(undefined),
      rateLimitResetCredits: z
        .object({
          availableCount: z.number().optional(),
          totalEarnedCount: z.number().optional(),
          nextExpiresAt: z.number().nullable().optional(),
          credits: z
            .array(
              z.object({
                status: z.string().optional(),
                expiresAt: z.union([z.number(), z.string()]).nullish(),
                grantedAt: z.union([z.number(), z.string()]).nullish()
              })
            )
            .optional()
        })
        .nullish()
        .catch(undefined)
    })
    .nullish()
    .catch(undefined)
})

export function parseCodexRateLimitRpcResponse(record: unknown) {
  const parsed = responseSchema.safeParse(record)
  return parsed.success ? parsed.data : null
}
