import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE } from '../../shared/project-host-setup-target'

export function assertCloneHostIsSupported(hostId: ExecutionHostId | null | undefined): void {
  if (parseExecutionHostId(hostId)?.kind === 'ssh') {
    throw new Error(
      `Cloning onto an SSH host is not supported. ${SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE}`
    )
  }
}
