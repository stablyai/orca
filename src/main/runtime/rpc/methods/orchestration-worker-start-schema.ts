import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

export const OptionalWorkerLaunchPreference = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim(), 'Surrounding whitespace is invalid')
  .optional()

export const WorkerStartParams = z
  .object({
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
    dispatchGroup: requiredString('Missing --dispatch-group')
      .refine((value) => value.length <= 128, 'Must contain at most 128 characters')
      .refine((value) => value === value.trim(), 'Surrounding whitespace is invalid'),
    dispatchIndex: z.number().int().safe().min(1),
    maxDispatches: z.number().int().safe().min(1).max(64),
    maxRuntimeMs: z.number().int().safe().min(1000).max(7_200_000),
    maxRequests: z.number().int().safe().min(1).max(100),
    maxReviewCycles: z.number().int().safe().min(0).max(2),
    reviewCycle: z.number().int().safe().min(1).max(2).optional(),
    devMode: z.boolean().optional()
  })
  .superRefine((value, ctx) => {
    if (value.dispatchIndex > value.maxDispatches) {
      ctx.addIssue({
        code: 'custom',
        path: ['dispatchIndex'],
        message: 'dispatchIndex must not exceed maxDispatches'
      })
    }
    if (value.maxReviewCycles === 0 && value.reviewCycle !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reviewCycle'],
        message: 'reviewCycle must be omitted when maxReviewCycles is zero'
      })
    }
    if (value.maxReviewCycles > 0 && value.reviewCycle === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reviewCycle'],
        message: 'reviewCycle is required when maxReviewCycles is greater than zero'
      })
    }
    if (value.reviewCycle !== undefined && value.reviewCycle > value.maxReviewCycles) {
      ctx.addIssue({
        code: 'custom',
        path: ['reviewCycle'],
        message: 'reviewCycle must not exceed maxReviewCycles'
      })
    }
  })

export type WorkerStartInput = z.infer<typeof WorkerStartParams>
