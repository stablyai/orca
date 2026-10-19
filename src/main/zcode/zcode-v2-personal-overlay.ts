import { z } from 'zod'

// Preserve raw own keys: Zod records erase __proto__ before emptiness checks.
const rawConfigSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
)

const modelRuleSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    config: rawConfigSchema
  })
  .strict()
const providerRuleSchema = z
  .object({
    providerId: z.string().min(1),
    templateId: z.string().min(1).nullable().optional(),
    providerName: z.string().min(1).nullable().optional(),
    enabled: z.boolean().optional(),
    config: rawConfigSchema
  })
  .strict()
const selectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    config: z
      .object({
        providerOrder: z.array(z.string().min(1)).optional(),
        providerConfigRules: z.object({ providerRules: z.array(providerRuleSchema) }).strict(),
        modelConfigRules: z
          .object({
            providerModelRules: z.array(modelRuleSchema),
            manualProviderModelRules: z.array(modelRuleSchema)
          })
          .strict(),
        defaultModelSelection: z
          .object({
            providerId: z.string().trim().min(1),
            modelId: z.string().trim().min(1),
            options: z
              .object({ reasoningLevel: z.string().trim().min(1).optional() })
              .strict()
              .optional()
          })
          .strict()
          .optional()
      })
      .strict()
  })
  .strict()

// ZCode 29628c9 validates the whole overlay before accepting its selected account.
export function readSupportedZcodeV2Selection(input: unknown) {
  const { config } = selectionSchema.parse(input)
  const providerRules = config.providerConfigRules.providerRules
  const providerIds = new Set(providerRules.map((rule) => rule.providerId))
  if (providerIds.size !== providerRules.length) {
    throw new Error('Invalid personal provider rules')
  }

  // Empty smart rules are validated; richer leaves and manual normalization are unsupported.
  if (
    providerRules.some((rule) => Object.keys(rule.config).length > 0) ||
    config.modelConfigRules.providerModelRules.some(
      (rule) => Object.keys(rule.config).length > 0
    ) ||
    config.modelConfigRules.manualProviderModelRules.length > 0
  ) {
    return undefined
  }
  return config.defaultModelSelection
}
