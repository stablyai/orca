import { parseExecutionHostId } from '../../../src/shared/execution-host'
import { assertFileMutationOwnershipCapability } from '../../../src/shared/file-mutation-ownership'
import type { RuntimeStatus } from '../../../src/shared/runtime-types'
import type { SshConnectionState, SshMutationExpectation } from '../../../src/shared/ssh-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcSuccess } from '../transport/types'

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
  client: Pick<RpcClient, 'sendRequest'>,
  worktree: string
): Promise<MobileFileMutationOwnership> {
  const status = await requestResult<Pick<RuntimeStatus, 'capabilities'>>(
    client,
    'status.get',
    undefined
  )
  assertFileMutationOwnershipCapability(status)

  const result = await requestResult<{ worktree?: { hostId?: string | null } }>(
    client,
    'worktree.show',
    { worktree }
  )
  if (!result.worktree) {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }

  const host = parseExecutionHostId(result.worktree.hostId)
  const sshState =
    host?.kind === 'ssh'
      ? (
          await requestResult<{ state: SshConnectionState | null }>(client, 'ssh.getState', {
            targetId: host.targetId
          })
        ).state
      : null
  return buildMobileFileMutationOwnership(result.worktree.hostId, sshState)
}

async function requestResult<TResult>(
  client: Pick<RpcClient, 'sendRequest'>,
  method: string,
  params: unknown
): Promise<TResult> {
  const response = await client.sendRequest(method, params, {
    timeoutMs: FILE_MUTATION_TIMEOUT_MS
  })
  if (!response.ok) {
    throw new Error((response as RpcFailure).error.message)
  }
  return (response as RpcSuccess).result as TResult
}
