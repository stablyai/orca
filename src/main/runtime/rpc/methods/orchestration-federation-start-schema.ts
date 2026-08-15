import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { OptionalWorkerLaunchPreference } from './orchestration-worker-start-schema'

const FEDERATION_DEADLINE_CLOCK_SKEW_MS = 60_000

export const FederationAttachStartParams = z
  .object({
    dispatchId: requiredString('Missing Dispatch ID').refine(
      (value) => /^ctx_[a-z0-9_]+$/.test(value),
      'Invalid Dispatch ID'
    ),
    taskId: requiredString('Missing Task ID'),
    taskSpec: requiredString('Missing Task spec'),
    protocolVersion: z.union([z.literal(1), z.literal(2)]),
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
    dispatchGroup: requiredString('Missing dispatch group'),
    dispatchIndex: z.number().int().safe().min(1),
    maxDispatches: z.number().int().safe().min(1).max(64),
    maxRuntimeMs: z.number().int().safe().min(1000).max(7_200_000),
    maxRequests: z.number().int().safe().min(1).max(100),
    maxReviewCycles: z.number().int().safe().min(0).max(2),
    reviewCycle: z.number().int().safe().min(1).max(2).optional(),
    deadlineAt: z.iso.datetime(),
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
    if (
      (value.maxReviewCycles === 0 && value.reviewCycle !== undefined) ||
      (value.maxReviewCycles > 0 &&
        (value.reviewCycle === undefined || value.reviewCycle > value.maxReviewCycles))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['reviewCycle'],
        message: 'reviewCycle must match maxReviewCycles'
      })
    }
    if (
      Date.parse(value.deadlineAt) - Date.now() >
      value.maxRuntimeMs + FEDERATION_DEADLINE_CLOCK_SKEW_MS
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['deadlineAt'],
        message: 'deadlineAt exceeds maxRuntimeMs plus clock-skew allowance'
      })
    }
  })

export type FederationAttachStartInput = z.infer<typeof FederationAttachStartParams>
