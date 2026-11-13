import { z } from 'zod'
const date = z.iso.datetime()
const sha = z.string().regex(/^[a-f0-9]{40,64}$/)
const text = z.string().min(1).max(8_192)
const chat = z.object({
  headSha: sha.nullable().default(null),
  sessionId: text,
  tabId: text,
  workspaceId: text,
  environmentId: text.nullable(),
  agent: z.string().min(1).max(128)
})
export const communityFeatureSchema = z.object({
  signals: z
    .object({
      headSha: sha,
      capturedAt: date,
      review: z.enum(['approved', 'changes-requested', 'none', 'unknown']),
      checks: z.enum(['passed', 'attention', 'pending', 'none', 'unknown'])
    })
    .nullable()
    .default(null),
  installed: z
    .object({ buildId: text, baseVersion: text, headSha: sha, title: text, observedAt: date })
    .nullable()
    .default(null),
  candidate: z
    .object({ id: z.uuid(), state: text, url: z.string().url().nullable(), headSha: sha })
    .nullable()
    .default(null),
  evidenceId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .default(null),
  release: z
    .object({
      headSha: sha,
      tag: text,
      releaseCommit: sha,
      mergeCommit: sha,
      url: z.string().url(),
      comparisonUrl: z.string().url(),
      observedAt: date
    })
    .nullable()
    .default(null),
  number: z.number().int().positive(),
  savedAt: date.nullable(),
  selectedAt: date.nullable(),
  visit: z.object({ headSha: sha, at: date }).nullable(),
  chat: chat.nullable(),
  source: z
    .object({
      title: z.string().max(65_536),
      headSha: sha,
      state: z.enum(['open', 'closed', 'merged']),
      observedAt: date,
      imageUrls: z.array(z.string().url()).max(24).default([])
    })
    .nullable()
})
const event = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  number: z.number().int().positive(),
  at: date,
  kind: z.string().min(1).max(128),
  actor: z.enum(['user', 'github', 'runner', 'build']),
  headSha: sha.nullable(),
  evidence: z.array(text).max(100),
  summary: z.string().max(8_192)
})
export const communityFeatureStateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  features: z.record(z.string().regex(/^\d+$/), communityFeatureSchema),
  events: z.array(event)
})
export type CommunityFeatureState = z.infer<typeof communityFeatureStateSchema>
