import type { CreateWorktreeArgs } from '../shared/worktree/create-types'
import type { CliWorkspaceProvenance } from '../shared/worktree/types'
import { selectSuggestedCreatureName } from '../shared/worktree-name-suggestion'
import { resolveWorktreeCreateDisplayNameRequest } from './ipc/worktree-display-name'

export function selectWorktreeCreateBranchSeed(
  request: Pick<
    CreateWorktreeArgs,
    'name' | 'displayName' | 'displayNameKind' | 'nameWasGenerated' | 'branchNameOverride'
  > & { cliProvenance?: CliWorkspaceProvenance },
  autoRenameBranchFromWork: boolean | undefined
): string | undefined {
  if (
    !autoRenameBranchFromWork ||
    request.branchNameOverride ||
    request.cliProvenance?.kind === 'created-by-cli'
  ) {
    return undefined
  }
  const label = resolveWorktreeCreateDisplayNameRequest(
    request.displayName,
    request.displayNameKind,
    request.name,
    false,
    request.nameWasGenerated === true
  )
  // Typed labels stay independent of the placeholder consumed by first-work naming.
  return label.kind === 'user' && label.value ? selectSuggestedCreatureName([]) : undefined
}
