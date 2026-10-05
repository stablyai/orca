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

export type MobileFileMutationSshState =
  | (Pick<SshConnectionState, 'connectionGeneration'> & { targetId?: string; status?: string })
  | null
  | undefined

export function buildMobileFileMutationOwnership(
  worktreeHostId: string | null | undefined,
  sshState: MobileFileMutationSshState = null
): MobileFileMutationOwnership {
  const host = parseExecutionHostId(worktreeHostId)
  if (!host || host.kind === 'runtime') {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }
  if (host.kind === 'local') {
    return { expectedExecutionHostId: 'local' }
  }
  if (
    sshState?.status !== 'connected' ||
    sshState.targetId !== host.targetId ||
    sshState.connectionGeneration === undefined
  ) {
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
  const summary = fileOwnershipWorktreeRead.interpret(worktreeReply)
  if (!summary) {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }

  const host = parseExecutionHostId(summary.hostId)
  let sshState: MobileFileMutationSshState = null
  if (host?.kind === 'ssh') {
    const stateReply = await fileOwnershipSshStateRead.request(
      client,
      { targetId: host.targetId },
      { timeoutMs: FILE_MUTATION_TIMEOUT_MS }
    )
    sshState = fileOwnershipSshStateRead.interpret(stateReply)
  }
  return buildMobileFileMutationOwnership(summary.hostId, sshState)
}
