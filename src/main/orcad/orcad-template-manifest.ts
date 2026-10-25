import { z } from 'zod'

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const TemplateTargetSchema = z
  .object({
    files: z.record(z.string(), Sha256Schema),
    packagedRipgrep: z.literal(true).optional(),
    browserName: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
      .optional(),
    browserSha256: Sha256Schema.optional()
  })
  .refine((target) => Boolean(target.browserName) === Boolean(target.browserSha256), {
    message: 'browserName and browserSha256 must either both be present or both be absent'
  })
export const OrcadTemplateManifestSchema = z.object({
  schemaVersion: z.union([z.literal(3), z.literal(4)]),
  commonSha256: z.record(z.string(), Sha256Schema),
  targets: z.record(z.string(), TemplateTargetSchema)
})

export type OrcadTemplateManifest = z.infer<typeof OrcadTemplateManifestSchema>
