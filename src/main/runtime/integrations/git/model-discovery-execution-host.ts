import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import {
  ExecutionHostNotDispatchableError,
  resolveGitRouteForHost
} from '../../../providers/execution-host-provider-dispatch'
import type { ModelDiscoveryWorkspace } from './runtime-git-command-target'

/** Terminal scope keeps a nested SSH id and drops `runtime:` ownership. Discovery must not. */
export function modelDiscoveryExecutionHost(input: {
  folder: { executionHostId?: string | null; connectionId?: string | null } | null
  gitExecutionHostId: ExecutionHostId | null
}): ExecutionHostId {
  if (input.folder) {
    return getRepoExecutionHostId(input.folder)
  }
  return input.gitExecutionHostId ?? LOCAL_EXECUTION_HOST_ID
}

/** A workspace this process can probe. `runtime:` hosts throw; they are not local and not this SSH registry. */
export function modelDiscoveryWorkspaceForHost(input: {
  path: string
  executionHostId: ExecutionHostId
  wslDistro?: string
}): ModelDiscoveryWorkspace {
  const route = resolveGitRouteForHost(input.executionHostId)
  switch (route.kind) {
    case 'local':
      return {
        path: input.path,
        executionHostId: route.hostId,
        ...(input.wslDistro ? { wslDistro: input.wslDistro } : {})
      }
    case 'ssh':
      return { path: input.path, executionHostId: route.hostId }
    case 'runtime':
      throw new ExecutionHostNotDispatchableError(route.hostId)
  }
}
