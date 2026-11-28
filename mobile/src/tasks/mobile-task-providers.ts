import type { TaskProvider } from '../../../src/shared/work-items/task-providers'

// The phone has no Gitea task views yet, so Gitea stays a desktop and web client source.
const DESKTOP_ONLY_TASK_PROVIDERS: ReadonlySet<TaskProvider> = new Set(['gitea'])

/** The phone's task sources; never empty, falling back to GitHub like the shared availability filter. */
export function mobileTaskProviders(providers: readonly TaskProvider[]): TaskProvider[] {
  const supported = providers.filter((provider) => !DESKTOP_ONLY_TASK_PROVIDERS.has(provider))
  return supported.length > 0 ? supported : ['github']
}
