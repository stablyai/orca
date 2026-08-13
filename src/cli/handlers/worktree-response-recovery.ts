import { RuntimeClientError } from '../runtime-client'

export function addWorktreeCreateRecovery(error: unknown, clientMutationId: string): unknown {
  if (!(error instanceof RuntimeClientError) || !isMutationCompletionWarning(error.data)) {
    return error
  }
  const data = error.data as Record<string, unknown>
  return new RuntimeClientError(error.code, error.message, {
    ...data,
    nextSteps: [
      'Run: orca worktree list --json and verify whether the worktree was created.',
      `If it is missing, retry the same command with --mutation-id ${clientMutationId}.`,
      'If it exists, do not retry blindly; a fresh create can create a second worktree and branch.'
    ]
  })
}

function isMutationCompletionWarning(data: unknown): boolean {
  return (
    !!data &&
    typeof data === 'object' &&
    (data as { mutationMayHaveCompleted?: unknown }).mutationMayHaveCompleted === true
  )
}
