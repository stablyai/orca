import { z } from 'zod'

const policy = z
  .object({
    workflow: z.string().regex(/^\.github\/workflows\/[a-z0-9-]+\.yml$/),
    branch: z.string().min(1),
    signingPolicy: z.enum(['release-signing', 'test-signing']),
    environments: z.object({
      inner: z.string().min(1),
      installer: z.string().min(1)
    })
  })
  .strict()

export const configSchema = z
  .object({
    repository: z.literal('stablyai/orca'),
    appId: z.string().regex(/^[1-9][0-9]*$/),
    installationId: z.number().int().positive(),
    privateKey: z.string().min(1),
    githubWebhookSecret: z.string().min(32),
    signpathWebhookSecret: z.string().min(32),
    reconcileSecret: z.string().min(32),
    signpathToken: z.string().min(1),
    signpathOrganization: z.string().uuid(),
    signpathProject: z.literal('orca'),
    policies: z.array(policy).min(1)
  })
  .strict()
  .superRefine((config, ctx) => {
    const environments = config.policies.flatMap((p) => Object.values(p.environments))
    if (new Set(environments).size !== environments.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Each signing policy needs distinct environments'
      })
    }
  })
export type SigningConfig = z.infer<typeof configSchema>
export type SigningPolicy = SigningConfig['policies'][number]
export type SigningStage = 'inner' | 'installer'
export const artifactConfigurations = {
  inner: 'windows-inner-binaries-zip',
  installer: 'github-actions-windows-installer'
} as const

export function readConfig(env = process.env): SigningConfig {
  return configSchema.parse({
    repository: 'stablyai/orca',
    appId: env.GITHUB_APP_ID,
    installationId: Number(env.GITHUB_INSTALLATION_ID),
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET,
    signpathWebhookSecret: env.SIGNPATH_WEBHOOK_SECRET,
    reconcileSecret: env.RECONCILE_SECRET,
    signpathToken: env.SIGNPATH_API_TOKEN,
    signpathOrganization: env.SIGNPATH_ORGANIZATION_ID,
    signpathProject: 'orca',
    policies: JSON.parse(env.SIGNING_POLICIES ?? '[]')
  })
}
