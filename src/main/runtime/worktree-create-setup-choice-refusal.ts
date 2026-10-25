import { OrchestrationError } from './orchestration/orchestration-error'

export const WORKTREE_CREATE_SETUP_CHOICE_REQUIRED_CODE = 'worktree_create_setup_choice_required'

// Only the setup check before workspace creation may raise this effect-free refusal.
export class WorktreeCreateSetupChoiceRefusedError extends OrchestrationError {
  constructor(message: string, options?: ErrorOptions) {
    super(WORKTREE_CREATE_SETUP_CHOICE_REQUIRED_CODE, message)
    this.cause = options?.cause
  }
}
