import { WorkspaceSelectorAmbiguousError } from '../catalog/workspace-selector-candidates'
import { WorktreeIdRequiresFullPathError } from './worktree-id-requires-full-path-error'

export class RuntimeLineageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
  }
}

export const LINEAGE_PARENT_AMBIGUOUS = 'LINEAGE_PARENT_AMBIGUOUS'

const PARENT_NOT_FOUND_NEXT_STEPS = [
  'Pass a valid --parent-worktree selector such as folder:<id>, worktree:<worktreeId>, id:<repo-id>::<path>, branch:<branch>, issue:<number>, path:<absolute-path>, name:<display-name>, or active/current.',
  'Retry with --no-parent for no parent.'
]

/** Why an explicit --parent-worktree failed, the same for create and set: several matches, or none. */
export function explicitParentError(error: unknown): RuntimeLineageError {
  if (error instanceof WorkspaceSelectorAmbiguousError) {
    return new RuntimeLineageError(LINEAGE_PARENT_AMBIGUOUS, error.message, error.data)
  }
  if (error instanceof Error && error.message === 'selector_ambiguous') {
    return new RuntimeLineageError(
      LINEAGE_PARENT_AMBIGUOUS,
      'More than one workspace matches the parent selector.',
      { nextSteps: ['Run `orca worktree ps --json` and pass the parent by identity:<key>.'] }
    )
  }
  return new RuntimeLineageError(
    'LINEAGE_PARENT_NOT_FOUND',
    error instanceof WorktreeIdRequiresFullPathError
      ? error.message
      : 'Parent selector was not found.',
    { nextSteps: PARENT_NOT_FOUND_NEXT_STEPS }
  )
}
