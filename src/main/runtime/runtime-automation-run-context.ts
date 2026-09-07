import type { Repo } from '../../shared/repo-types'
import type {
  RuntimeAutomationCreateInput,
  RuntimeAutomationUpdateInput
} from './runtime-automation-controller'

export function assertAutomationRunContextMatchesTarget(
  runContext:
    | RuntimeAutomationCreateInput['runContext']
    | RuntimeAutomationUpdateInput['runContext'],
  repo: Repo | null
): void {
  if (!runContext || !repo) {
    return
  }
  if (runContext.repoId !== repo.id || runContext.path !== repo.path) {
    throw new Error('Automation project does not match its run context.')
  }
}
