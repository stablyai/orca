import { assertCommanderProject } from './commander-project'
import { isFolderRepo } from '../../../../../../../../shared/repository/repo-kind'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import { OrchestrationError } from '../../../../../../orchestration/orchestration-error'

export async function assertOrchestrationWorktreeCreationSupported(args: {
  runtime: OrcaRuntimeService
  repoSelector: string
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

/** The existing workspace a worker reuses, or none once a new worktree's repo can host one. */
export async function resolveExistingWorkerWorkspace(
  runtime: OrcaRuntimeService,
  creationTarget: { repoSelector: string } | undefined,
  existingWorktree: string,
  commander?: { projectId: string }
): Promise<Awaited<ReturnType<OrcaRuntimeService['showManagedTerminalWorkspace']>> | undefined> {
  if (!creationTarget) {
    const workspace = await runtime.showManagedTerminalWorkspace(existingWorktree)
    if (commander) {
      await assertCommanderProject(runtime, commander.projectId, `id:${workspace.repoId}`)
    }
    return workspace
  }
  await assertOrchestrationWorktreeCreationSupported({
    runtime,
    repoSelector: creationTarget.repoSelector,
    existingPlacement: 'current or an exact existing folder workspace'
  })
  if (commander) {
    await assertCommanderProject(runtime, commander.projectId, creationTarget.repoSelector)
  }
  return undefined
}
