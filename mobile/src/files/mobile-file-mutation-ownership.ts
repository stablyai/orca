import { parseExecutionHostId } from '../../../src/shared/execution-host'
import { assertFileMutationOwnershipCapability } from '../../../src/shared/file-mutation-ownership'
import type { SshConnectionState, SshMutationExpectation } from '../../../src/shared/ssh-types'
import { translate } from '../i18n/mobile-i18n'
import {
  fileOwnershipRuntimeStatusRead,
  fileOwnershipSshStateRead,
  fileOwnershipWorktreeRead,
  type MobileFileOwnershipRpcSender
} from './mobile-file-ownership-operations'

const FILE_MUTATION_TIMEOUT_MS = 15_000

function sshOwnerChangedMessage(): string {
  return translate(
    'files.fileMutationOwnership.sshOwnerChanged',
    "Couldn't verify the SSH connection. Reconnect the host and try again."
  )
}

export type MobileFileMutationOwnership = SshMutationExpectation & {
  expectedExecutionHostId: 'local' | `ssh:${string}`
}

// Keep absence distinct from null; the host omits state when it has no target connection.
export type MobileFileMutationSshState =
  | (Pick<SshConnectionState, 'connectionGeneration'> & { targetId?: string })
  | null
  | undefined

export function buildMobileFileMutationOwnership(
  worktreeHostId: string | null | undefined,
  sshState: MobileFileMutationSshState = null
): MobileFileMutationOwnership {
  const host = parseExecutionHostId(worktreeHostId)
  if (worktreeHostId !== undefined && !host) {
    throw new Error(sshOwnerChangedMessage())
  }
  if (!host || host.kind === 'local' || host.kind === 'runtime') {
    return { expectedExecutionHostId: 'local' }
  }
  if (sshState?.targetId !== host.targetId || sshState.connectionGeneration === undefined) {
    throw new Error(sshOwnerChangedMessage())
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
    throw new Error(sshOwnerChangedMessage())
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
