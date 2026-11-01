/** Never route an unavailable remote host to a same-named local path. */

import {
  parseExecutionHostId,
  type ExecutionHostId,
  type LOCAL_EXECUTION_HOST_ID
} from '../shared/execution-host'
import {
  CLIENT_REMOVAL_HOME,
  executionHostRemovalHome,
  type WorktreeRemovalHomeAuthority
} from './worktree-removal-home-guard'
import {
  ExecutionHostNotDispatchableError,
  resolveGitRouteForHost
} from './providers/execution-host-provider-dispatch'
import {
  SshHostNotServedError,
  SSH_WORKTREE_REMOVAL_NOT_SERVED_MESSAGE
} from './providers/ssh-host-not-served-error'

export type WorktreeRemovalRoute = { kind: 'local'; hostId: typeof LOCAL_EXECUTION_HOST_ID }

export function resolveWorktreeRemovalRoute(hostId: ExecutionHostId): WorktreeRemovalRoute {
  const route = resolveGitRouteForHost(hostId)
  switch (route.kind) {
    case 'local':
      return { kind: 'local', hostId: route.hostId }
    case 'runtime':
      throw new ExecutionHostNotDispatchableError(route.hostId)
    case 'ssh':
      throw new SshHostNotServedError(route.connectionId, SSH_WORKTREE_REMOVAL_NOT_SERVED_MESSAGE)
  }
}

export function resolveWorktreeRemovalHome(
  route: WorktreeRemovalRoute
): WorktreeRemovalHomeAuthority {
  return resolveWorktreeRemovalHomeForHost(route.hostId)
}

/** A nullable connectionId cannot establish that the client owns the filesystem or its home. */
export function resolveWorktreeRemovalHomeForHost(
  hostId: ExecutionHostId
): WorktreeRemovalHomeAuthority {
  const parsed = parseExecutionHostId(hostId)
  switch (parsed?.kind) {
    case 'local':
      return CLIENT_REMOVAL_HOME
    // Only a local host may use this client's home as deletion authority.
    case 'ssh':
    case 'runtime':
    case undefined:
      return executionHostRemovalHome(null)
  }
}
