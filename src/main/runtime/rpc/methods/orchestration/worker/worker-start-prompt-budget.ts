import {
  isWorkerStartTaskSpecTooLarge,
  ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES
} from '../../../../../../shared/orchestration-worker-start-prompt-budget'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

export async function assertWorkerStartTaskSpecWithinPromptBudget(spec: string): Promise<void> {
  if (!(await isWorkerStartTaskSpecTooLarge(spec))) {
    return
  }
  throw new OrchestrationError(
    'worker_prompt_too_large',
    `Worker Task spec exceeds the ${ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES}-byte worker-start limit. Shorten the spec or place large context in a workspace file and reference its path. No Task, Dispatch, worktree, or terminal effects were applied.`,
    {
      maxTaskSpecBytes: ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES,
      effectsApplied: false,
      nextSteps: ['Shorten the Task spec or save large context in the workspace and reference it.']
    }
  )
}
