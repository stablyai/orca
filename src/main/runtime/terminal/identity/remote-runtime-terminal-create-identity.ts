import { createHash } from 'node:crypto'

export type TerminalCreateOperationKind = 'create' | 'account-restart'

export function deriveRemoteRuntimeTerminalCreateHandle(
  clientIdentity: string,
  worktreeId: string,
  clientMutationId: string,
  kind: TerminalCreateOperationKind = 'create'
): string {
  const digest = createHash('sha256')
    .update(
      kind === 'account-restart'
        ? 'orca.remote-terminal-account-restart.v1\0'
        : 'orca.remote-terminal-create.v2\0'
    )
    .update(clientIdentity)
    .update('\0')
    .update(worktreeId)
    .update('\0')
    .update(clientMutationId)
    .digest('hex')
  return `term_${digest.slice(0, 32)}`
}
