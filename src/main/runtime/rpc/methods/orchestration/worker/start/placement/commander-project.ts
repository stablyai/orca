import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import { OrchestrationError } from '../../../../../../orchestration/orchestration-error'

export async function assertCommanderProject(
  runtime: OrcaRuntimeService,
  projectId: string,
  repoSelector: string
) {
  const repo = await runtime.showRepo(repoSelector)
  if (
    !runtime
      .listVisibleProjectHostSetups()
      .some((setup) => setup.repoId === repo.id && setup.projectId === projectId)
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      'The worker checkout belongs to a different project than the Commander grant.'
    )
  }
}
