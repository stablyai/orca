import { z } from 'zod'
import { isTuiAgent } from '../../../../../../shared/tui-agent-config'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
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
    attemptId: OptionalString,
    replacementOf: OptionalString,
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

type PersistedWorkerStartOptions = {
  worktree?: string
  resolvedWorktreeId?: string | null
  agent?: string | null
  launch?: { requested?: { agent?: string | null; model?: string | null; effort?: string | null } }
}

export function resolveReplacementWorkerStart(
  params: WorkerStartInput,
  db: OrchestrationDb
): WorkerStartInput {
  if (!params.replacementOf) {
    return params
  }
  if (params.retryOf || params.terminal || params.agent) {
    throw new OrchestrationError(
      'invalid_argument',
      'replace-worker derives placement from its predecessor and cannot combine with retry or launch overrides.'
    )
  }
  const predecessor = db.getWorkerDispatch(params.replacementOf)
  if (!predecessor) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Replacement predecessor ${params.replacementOf} was not found.`
    )
  }
  const options = JSON.parse(predecessor.start_options) as PersistedWorkerStartOptions
  const requested = options.launch?.requested
  const agent = options.agent ?? requested?.agent
  if (!agent || !isTuiAgent(agent)) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'The replacement predecessor has no reproducible configured agent identity.'
    )
  }
  return {
    ...params,
    agent,
    model: requested?.model ?? undefined,
    effort: requested?.effort ?? undefined,
    worktree: options.resolvedWorktreeId ? `id:${options.resolvedWorktreeId}` : options.worktree,
    attemptId: `replacement-${params.replacementOf}`
  }
}
