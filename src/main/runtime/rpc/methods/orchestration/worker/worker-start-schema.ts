import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../../../schemas'

export const OptionalWorkerLaunchPreference = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim(), 'Surrounding whitespace is invalid')
  .optional()

export const WorkerStartParams = z
  .object({
    task: OptionalString,
    spec: OptionalString,
    taskTitle: OptionalString,
    deps: OptionalString,
    parent: OptionalString,
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
    devMode: z.boolean().optional()
  })
  .superRefine((params, ctx) => {
    if (!params.task && !params.spec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['task'],
        message: 'Missing --task or --spec'
      })
    }
    if (params.task && params.spec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['spec'],
        message: '--task and --spec are mutually exclusive'
      })
    }
    // Why: --spec creates a new Task, so a retry link to a prior Dispatch could never resolve and
    // the refusal named a Task id the caller never supplied.
    if (params.retryOf && params.spec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retryOf'],
        message:
          '--retry-of needs --task <task_id> naming the failed Task; --spec creates a new one'
      })
    }
  })

export type WorkerStartInput = z.infer<typeof WorkerStartParams>
