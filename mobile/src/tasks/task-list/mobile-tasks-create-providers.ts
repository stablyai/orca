import type { TaskProvider } from '../../../../src/shared/work-items/task-providers'

type CreatableTaskProvider = Extract<TaskProvider, 'github' | 'gitlab' | 'linear'>

// Jira and ClickUp are browse-and-update only on mobile, so the create sheet has nothing to submit for them.
export function providerSupportsTaskCreate(
  provider: TaskProvider
): provider is CreatableTaskProvider {
  return provider === 'github' || provider === 'gitlab' || provider === 'linear'
}
