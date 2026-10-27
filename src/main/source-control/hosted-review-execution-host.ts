import type { ExecutionHostId } from '../../shared/execution-host'
import {
  ExecutionHostNotDispatchableError,
  resolveGitRouteForHost
} from '../providers/execution-host-provider-dispatch'

/** Resolve routing explicitly (#11163): null connectionId conflated local, unresolved and remote ownership. runtime: must refuse here because nested SSH ids belong to that server; store-backed callers first resolve client-dialable ownership. */
export function hostedReviewSshConnectionId(executionHostId: ExecutionHostId): string | null {
  const route = resolveGitRouteForHost(executionHostId)
  if (route.kind === 'runtime') {
    throw new ExecutionHostNotDispatchableError(route.hostId)
  }
  return route.kind === 'ssh' ? route.connectionId : null
}
