import { WorkspaceSelectorAmbiguousError } from '../catalog/workspace-selector-candidates'

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

/** An explicit parent selector that matched several workspaces, with its choices when known. */
export function explicitParentAmbiguousError(error: unknown): RuntimeLineageError | undefined {
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
  return undefined
}
