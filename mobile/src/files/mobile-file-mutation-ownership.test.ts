import { describe, expect, it, vi } from 'vitest'
import type { SshConnectionState } from '../../../src/shared/ssh-types'
import { FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY } from '../../../src/shared/file-access/files-runtime-capabilities'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import {
  buildMobileFileMutationOwnership,
  captureMobileFileMutationOwnership
} from './mobile-file-mutation-ownership'

function success(result: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function clientWithResponses(responses: RpcResponse[]): {
  client: Pick<RpcClient, 'sendRequest'>
  sendRequest: ReturnType<typeof vi.fn>
} {
  const sendRequest = vi.fn(async () => {
    const response = responses.shift()
    if (!response) {
      throw new Error('Unexpected RPC request')
    }
    return response
  })
  return { client: { sendRequest }, sendRequest }
}

function sshState(targetId: string, connectionGeneration: number | undefined): SshConnectionState {
  return {
    targetId,
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    connectionGeneration
  }
}

describe('mobile file mutation ownership', () => {
  it.each([undefined, 'local', 'runtime:environment-1'])(
    'binds %s worktrees to the runtime-local file host',
    (hostId) => {
      expect(buildMobileFileMutationOwnership(hostId)).toEqual({
        expectedExecutionHostId: 'local'
      })
    }
  )

  it('binds SSH worktrees to the target and live connection generation', () => {
    expect(
      buildMobileFileMutationOwnership('ssh:target%20one', sshState('target one', 17))
    ).toEqual({
      expectedExecutionHostId: 'ssh:target%20one',
      expectedSshTargetId: 'target one',
      expectedSshConnectionGeneration: 17
    })
  })

  it.each([
    ['a malformed owner', 'not-an-execution-host', null],
    ['a missing SSH state', 'ssh:target-1', null],
    ['a mismatched SSH target', 'ssh:target-1', sshState('target-2', 4)],
    ['a missing SSH generation', 'ssh:target-1', sshState('target-1', undefined)]
  ])('rejects %s', (_name, hostId, state) => {
    expect(() => buildMobileFileMutationOwnership(hostId, state)).toThrow(
      "Couldn't verify the SSH connection"
    )
  })

  // Absent hostId captures local; explicit null refuses an unplaceable host instead of sending its write locally.
  it('captures local ownership for a workspace whose reply records no host', async () => {
    const { client } = clientWithResponses([
      success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] }),
      success({ worktree: {} })
    ])

    await expect(captureMobileFileMutationOwnership(client, 'id:worktree-1')).resolves.toEqual({
      expectedExecutionHostId: 'local'
    })
  })

  it('refuses a workspace whose reply names an explicit null host', async () => {
    const { client } = clientWithResponses([
      success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] }),
      success({ worktree: { hostId: null } })
    ])

    await expect(captureMobileFileMutationOwnership(client, 'id:worktree-1')).rejects.toThrow(
      "Couldn't verify the SSH connection"
    )
  })
})
