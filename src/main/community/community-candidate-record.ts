import { z } from 'zod'
const sha = z.string().regex(/^[a-f0-9]{40}$/)
export const communityCandidatePlanSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  baseSha: sha,
  profileMode: z
    .enum(['isolated-preview', 'interactive-preview', 'shared-profile'])
    .nullable()
    .default(null),
  customSource: z
    .object({ repository: z.string().regex(/^[a-z\d-]{1,39}\/orca$/i), commit: sha })
    .nullable(),
  includedChanges: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        pullRequest: z
          .object({ number: z.number().int().positive(), headSha: sha, url: z.string().url() })
          .optional()
      })
    )
    .max(100),
  additions: z
    .array(
      z.object({
        number: z.number().int().positive(),
        title: z.string(),
        headSha: sha,
        sourceUrl: z.string().url()
      })
    )
    .max(12),
  digest: z.string().regex(/^[a-f0-9]{64}$/)
})
export const communityCandidateRunSchema = z.object({
  artifact: z
    .object({
      artifactId: z.number(),
      name: z.string(),
      path: z.string(),
      bytes: z.number(),
      digest: z.string(),
      githubDigestMatched: z.boolean(),
      stagedAt: z.string(),
      sourceUrl: z.string().url()
    })
    .nullable()
    .default(null),
  plan: communityCandidatePlanSchema,
  repository: z.string(),
  workflowRef: z.string(),
  workflowCommit: sha,
  source: z.object({ repository: z.string(), commit: sha, branch: z.string() }).nullable(),
  requestedAt: z.string(),
  runId: z.number().nullable(),
  url: z.string().nullable(),
  state: z.string(),
  conclusion: z.string().nullable(),
  artifactUrl: z.string().nullable()
})
