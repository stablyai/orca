import { isFolderRepo } from '../../../../../../../../shared/repository/repo-kind'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import type { RuntimeRepoSelector } from '../../../../../../workspaces/catalog/runtime-repo-selector'
import { OrchestrationError } from '../../../../../../orchestration/orchestration-error'

export async function assertOrchestrationWorktreeCreationSupported(args: {
  runtime: OrcaRuntimeService
  repoSelector: RuntimeRepoSelector
  existingPlacement: string
}): Promise<void> {
  if (!isFolderRepo(await args.runtime.showRepo(args.repoSelector))) {
    return
  }
  throw new OrchestrationError(
    'invalid_argument',
    `Folder projects cannot create orchestration worktrees; use ${args.existingPlacement}.`
  )
}
