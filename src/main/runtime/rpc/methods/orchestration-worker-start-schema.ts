import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

export const OptionalWorkerLaunchPreference = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim(), 'Surrounding whitespace is invalid')
  .optional()

export const WorkerStartParams = z.object({
  task: requiredString('Missing --task'),
  on: OptionalString,
  run: OptionalString,
  from: requiredString('Missing --from'),
  worktree: OptionalString,
  name: OptionalString,
  repo: OptionalString,
  baseBranch: OptionalString,
  displayName: OptionalString,
  comment: OptionalString,
  setup: z.enum(['run', 'skip', 'inherit']).optional(),
  terminal: OptionalString,
  agent: OptionalString,
  model: OptionalWorkerLaunchPreference,
  effort: OptionalWorkerLaunchPreference,
  retryOf: OptionalString,
  timeoutMs: OptionalFiniteNumber,
  devMode: z.boolean().optional(),
  /** Id of a typed, single-use certification intent the runtime minted. It is
   *  matched field-by-field against the launch actually being performed; a bare
   *  assertion from the caller authorises nothing. */
  certificationIntent: OptionalString
})

export type WorkerStartInput = z.infer<typeof WorkerStartParams>
