import { z } from 'zod'

export const RELAY_REGIONS = ['us-central1', 'asia-east2'] as const

export const RelayRegionSchema = z.enum(RELAY_REGIONS)

export type RelayRegion = z.infer<typeof RelayRegionSchema>

export const RELAY_DEFAULT_REGION: RelayRegion = 'us-central1'

const RelayProbeOriginSchema = z.string().url().max(2_048).refine(isCanonicalHttpsOrigin)

export const RelayRegionCatalogResponseSchema = z
  .object({
    v: z.literal(1),
    regions: z
      .array(
        z
          .object({
            region: RelayRegionSchema,
            probeOrigins: z.array(RelayProbeOriginSchema).min(1).max(2)
          })
          .strict()
      )
      .max(RELAY_REGIONS.length)
  })
  .strict()
  .superRefine((catalog, context) => {
    const regions = new Set<RelayRegion>()
    const origins = new Set<string>()
    for (const [regionIndex, entry] of catalog.regions.entries()) {
      if (regions.has(entry.region)) {
        context.addIssue({
          code: 'custom',
          message: 'duplicate relay region',
          path: ['regions', regionIndex, 'region']
        })
      }
      regions.add(entry.region)
      for (const [originIndex, origin] of entry.probeOrigins.entries()) {
        if (origins.has(origin)) {
          context.addIssue({
            code: 'custom',
            message: 'duplicate relay probe origin',
            path: ['regions', regionIndex, 'probeOrigins', originIndex]
          })
        }
        origins.add(origin)
      }
    }
  })

export type RelayRegionCatalogResponse = z.infer<typeof RelayRegionCatalogResponseSchema>

function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value
  } catch {
    return false
  }
}
