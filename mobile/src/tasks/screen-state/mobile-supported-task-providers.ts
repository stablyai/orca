import type { TaskProvider } from '../../../../src/shared/work-items/task-providers'

// ClickUp tasks are browsed on desktop and through the CLI; the mobile Tasks screen has no ClickUp list, so a host that shows ClickUp must not land this screen on it.
export function filterMobileTaskProviders(providers: readonly TaskProvider[]): TaskProvider[] {
  return providers.filter((provider) => provider !== 'clickup')
}
