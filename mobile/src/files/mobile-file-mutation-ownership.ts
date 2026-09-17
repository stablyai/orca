import { parseExecutionHostId } from '../../../src/shared/execution-host'
import { assertFileMutationOwnershipCapability } from '../../../src/shared/file-mutation-ownership'
import type { SshConnectionState, SshMutationExpectation } from '../../../src/shared/ssh-types'
import {
  fileOwnershipRuntimeStatusRead,
  fileOwnershipSshStateRead,
  fileOwnershipWorktreeRead,
  type MobileFileOwnershipRpcSender
} from './mobile-file-ownership-operations'

const FILE_MUTATION_TIMEOUT_MS = 15_000
const SSH_OWNER_CHANGED_MESSAGE =
  "Couldn't verify the SSH connection. Reconnect the host and try again."

export type MobileFileMutationOwnership = SshMutationExpectation & {
  expectedExecutionHostId: 'local' | `ssh:${string}`
}

export function buildMobileFileMutationOwnership(
  worktreeHostId: string | null | undefined,
  sshState: SshConnectionState | null = null
): MobileFileMutationOwnership {
  const host = parseExecutionHostId(worktreeHostId)
  if (worktreeHostId !== undefined && !host) {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }
  if (!host || host.kind === 'local' || host.kind === 'runtime') {
    return { expectedExecutionHostId: 'local' }
  }
  if (sshState?.targetId !== host.targetId || sshState.connectionGeneration === undefined) {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }
  return {
    expectedExecutionHostId: host.id,
    expectedSshTargetId: host.targetId,
    expectedSshConnectionGeneration: sshState.connectionGeneration
  }
}

export async function captureMobileFileMutationOwnership(
  client: MobileFileOwnershipRpcSender,
  worktree: string
): Promise<MobileFileMutationOwnership> {
  const statusReply = await fileOwnershipRuntimeStatusRead.request(client, undefined, {
    timeoutMs: FILE_MUTATION_TIMEOUT_MS
  })
  const status = fileOwnershipRuntimeStatusRead.interpret(statusReply)
  assertFileMutationOwnershipCapability(status)

  const worktreeReply = await fileOwnershipWorktreeRead.request(
    client,
    { worktree },
    { timeoutMs: FILE_MUTATION_TIMEOUT_MS }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
  const summary = fileOwnershipWorktreeRead.interpret(worktreeReply) as
    | { hostId?: string | null }
    | undefined
  if (!summary) {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }

  const host = parseExecutionHostId(summary.hostId)
  let sshState: SshConnectionState | null = null
  if (host?.kind === 'ssh') {
    const stateReply = await fileOwnershipSshStateRead.request(
      client,
      { targetId: host.targetId },
      { timeoutMs: FILE_MUTATION_TIMEOUT_MS }
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
    sshState = fileOwnershipSshStateRead.interpret(stateReply) as SshConnectionState | null
  }
  return buildMobileFileMutationOwnership(summary.hostId, sshState)
}
