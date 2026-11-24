import type { TaskProvider } from '../../../src/shared/work-items/task-providers'

// The phone has no Gitea task views yet, so Gitea stays a desktop and web client source.
const DESKTOP_ONLY_TASK_PROVIDERS: ReadonlySet<TaskProvider> = new Set(['gitea'])

export function mobileTaskProviders(providers: readonly TaskProvider[]): TaskProvider[] {
  return providers.filter((provider) => !DESKTOP_ONLY_TASK_PROVIDERS.has(provider))
}
