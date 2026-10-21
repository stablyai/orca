import type { ProjectRuntimeResolutionStore } from '../local-project-runtime-resolution'
import type { RuntimeStore } from '../runtime/runtime-store-contract'

export type RegisteredWorktreeRootStore = Pick<RuntimeStore, 'getRepos'> &
  Pick<ProjectRuntimeResolutionStore, 'getProjects' | 'getSettings'>
