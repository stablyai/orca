import type { ProjectRuntimeResolutionStore } from '../../../workspaces/execution-host/local-project-runtime-resolution'
import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'

export type RegisteredWorktreeRootStore = Pick<RuntimeStore, 'getRepos'> &
  Pick<ProjectRuntimeResolutionStore, 'getProjects' | 'getSettings'>
