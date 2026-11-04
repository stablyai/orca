import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'

// cloneRepo runs locally; accepting SSH would register the client's checkout as a remote repo.
export function assertCloneHostIsSupported(hostId: ExecutionHostId | null | undefined): void {
  if (parseExecutionHostId(hostId)?.kind !== 'ssh') {
    return
  }
  throw new Error(
    'Cloning onto an SSH host is not supported. Clone the repository on the host, then set the project up from that existing folder.'
  )
}
