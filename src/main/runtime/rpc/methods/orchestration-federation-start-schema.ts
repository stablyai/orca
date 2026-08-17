import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { OptionalWorkerLaunchPreference } from './orchestration-worker-start-schema'

export const FederationAttachStartParams = z.object({
  dispatchId: requiredString('Missing Dispatch ID'),
  taskId: requiredString('Missing Task ID'),
  taskSpec: requiredString('Missing Task spec'),
  protocolVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  worktree: requiredString('Missing remote worktree selector'),
  name: OptionalString,
  repo: OptionalString,
  baseBranch: OptionalString,
  displayName: OptionalString,
  comment: OptionalString,
  setup: z.enum(['run', 'skip', 'inherit']).optional(),
  setupSource: z.enum(['explicit_request', 'orchestration_default']).optional(),
  terminal: OptionalString,
  agent: OptionalString,
  model: OptionalWorkerLaunchPreference,
  effort: OptionalWorkerLaunchPreference,
  timeoutMs: OptionalFiniteNumber,
  devMode: z.boolean().optional()
})

export type FederationAttachStartInput = z.infer<typeof FederationAttachStartParams>
