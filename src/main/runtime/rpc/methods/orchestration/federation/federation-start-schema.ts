import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../../../schemas'
import { OptionalWorkerLaunchPreference } from '../worker/worker-start-schema'

// Why: clients and worker servers update independently, so a current server must
// still attach a peer speaking protocol 1 to 3. Only the attempt-bound variant (4)
// carries authoritative run identity, so the two shapes are separate variants
// rather than one object with optional identity — a v4 attachment can never fall
// back to the looser shape, and a legacy attachment can never claim a lease.
const FederationAttachStartCommon = {
  /** Omitted by v1.4.198 coordinators; the worker host then mints a stub home Run. */
  runId: OptionalString,
  dispatchId: requiredString('Missing Dispatch ID'),
  taskId: requiredString('Missing Task ID'),
  retryOf: OptionalString,
  taskSpec: requiredString('Missing Task spec'),
  /** Depth stamped by the Run home; omitted by older clients and defaults to 1. */
  depth: z.number().int().min(1).optional(),
  worktree: requiredString('Missing remote worktree selector'),
  name: OptionalString,
  repo: OptionalString,
  baseBranch: OptionalString,
  displayName: OptionalString,
  displayNameKind: z.enum(['generated', 'user']).optional(),
  comment: OptionalString,
  setup: z.enum(['run', 'skip', 'inherit']).optional(),
  setupSource: z.enum(['explicit_request', 'orchestration_default']).optional(),
  terminal: OptionalString,
  agent: OptionalString,
  model: OptionalWorkerLaunchPreference,
  effort: OptionalWorkerLaunchPreference,
  timeoutMs: OptionalFiniteNumber,
  devMode: z.boolean().optional()
}

const AttemptBoundAttachStartParams = z.object({
  ...FederationAttachStartCommon,
  protocolVersion: z.literal(4),
  attemptId: requiredString('Missing attempt ID'),
  runId: requiredString('Missing Run ID'),
  coordinatorGeneration: z.number().int().positive()
})

function legacyAttachStartParams(protocolVersion: 1 | 2 | 3) {
  return z.object({
    ...FederationAttachStartCommon,
    protocolVersion: z.literal(protocolVersion)
  })
}

export const FederationAttachStartParams = z.discriminatedUnion('protocolVersion', [
  legacyAttachStartParams(1),
  legacyAttachStartParams(2),
  legacyAttachStartParams(3),
  AttemptBoundAttachStartParams
])

export type FederationAttachStartInput = z.infer<typeof FederationAttachStartParams>

/** True only for the variant that carries authoritative run identity for a lease. */
export function isAttemptBoundAttachStart(
  params: FederationAttachStartInput
): params is z.infer<typeof AttemptBoundAttachStartParams> {
  return params.protocolVersion === 4
}
