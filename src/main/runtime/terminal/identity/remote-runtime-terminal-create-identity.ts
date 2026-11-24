import { createHash } from 'node:crypto'

export function deriveRemoteRuntimeTerminalCreateHandle(
  clientIdentity: string,
  worktreeId: string,
  clientMutationId: string
): string {
  const digest = createHash('sha256')
    .update('orca.remote-terminal-create.v2\0')
    .update(clientIdentity)
    .update('\0')
    .update(worktreeId)
    .update('\0')
    .update(clientMutationId)
    .digest('hex')
  return `term_${digest.slice(0, 32)}`
}
