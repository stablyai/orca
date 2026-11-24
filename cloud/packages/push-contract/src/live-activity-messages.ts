import { z } from 'zod'

const key = z.string().regex(/^[a-f0-9]{64}$/)
const state = z.enum(['working', 'attention', 'done', 'failed', 'unavailable'])
export const LiveActivityCountsSchema = z.object({
  working: z.number().int().min(0).max(320000),
  attention: z.number().int().min(0).max(320000),
  done: z.number().int().min(0).max(320000),
  failed: z.number().int().min(0).max(320000),
  unavailable: z.number().int().min(0).max(320000)
}).strict()
const session = z.object({
  segment: z.string().regex(/^[a-f0-9]{32}$/),
  id: z.string().regex(/^[a-f0-9]{32}$/), title: z.string().max(40), state,
  elapsedSeconds: z.number().min(0).max(604800)
}).strict()
export const LiveActivityBootstrapSchema = z.object({
  schemaVersion: z.literal(2), overviewId: z.uuid(), controlKey: key,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  showNames: z.boolean(),
  discoveryComplete: z.boolean(),
  token: z.string().min(2).max(4096).regex(/^(?:[a-f0-9]{2})+$/i),
  apnsEnvironment: z.enum(['sandbox', 'production']),
  scopes: z.array(key).min(1).max(32)
}).strict()
export const LiveActivityContributionSchema = z.object({
  schemaVersion: z.literal(2), overviewId: z.uuid(), scopeKey: key,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  event: z.enum(['update', 'end']),
  content: z.object({ counts: LiveActivityCountsSchema, sessions: z.array(session).max(3), complete: z.boolean() }).strict()
}).strict()
export const LiveActivityContentSchema = z.object({
  schemaVersion: z.literal(2), state, title: z.string().min(1).max(80),
  stateStartedAt: z.number().nonnegative(), updatedAt: z.number().nonnegative(),
  counts: LiveActivityCountsSchema,
  sessions: z.array(session.omit({ elapsedSeconds: true }).extend({
    scopeId: key, stateStartedAt: z.number().nonnegative()
  })).max(3),
  knownSources: z.number().int().min(0).max(32), totalSources: z.number().int().min(1).max(32), complete: z.boolean()
}).strict()
export const LiveActivitySendSchema = z.object({
  token: LiveActivityBootstrapSchema.shape.token,
  apnsEnvironment: LiveActivityBootstrapSchema.shape.apnsEnvironment,
  timestamp: z.number().int().positive(), event: z.enum(['update', 'end']), content: LiveActivityContentSchema
}).strict()

export type LiveActivitySend = z.infer<typeof LiveActivitySendSchema>
export type LiveActivityBootstrap = z.infer<typeof LiveActivityBootstrapSchema>
export type LiveActivityContribution = z.infer<typeof LiveActivityContributionSchema>
export type LiveActivityContent = z.infer<typeof LiveActivityContentSchema>
