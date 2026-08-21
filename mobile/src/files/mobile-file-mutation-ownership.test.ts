import { describe, expect, it, vi } from 'vitest'
import type { SshConnectionState } from '../../../src/shared/ssh-types'
import {
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  FILE_MUTATION_OWNERSHIP_UPDATE_REQUIRED_MESSAGE
} from '../../../src/shared/protocol-version'
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

  it('captures local ownership only after verifying the runtime capability', async () => {
    const { client, sendRequest } = clientWithResponses([
      success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] }),
      success({ worktree: { hostId: 'local' } })
    ])

    await expect(captureMobileFileMutationOwnership(client, 'id:worktree-1')).resolves.toEqual({
      expectedExecutionHostId: 'local'
    })
    expect(sendRequest.mock.calls).toEqual([
      ['status.get', undefined, { timeoutMs: 15_000 }],
      ['worktree.show', { worktree: 'id:worktree-1' }, { timeoutMs: 15_000 }]
    ])
  })

  it('captures SSH generation from the HUB before building mutation params', async () => {
    const state = sshState('target-1', 9)
    const { client, sendRequest } = clientWithResponses([
      success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] }),
      success({ worktree: { hostId: 'ssh:target-1' } }),
      success({ state })
    ])

    await expect(captureMobileFileMutationOwnership(client, 'id:worktree-1')).resolves.toEqual({
      expectedExecutionHostId: 'ssh:target-1',
      expectedSshTargetId: 'target-1',
      expectedSshConnectionGeneration: 9
    })
    expect(sendRequest.mock.calls[2]).toEqual([
      'ssh.getState',
      { targetId: 'target-1' },
      { timeoutMs: 15_000 }
    ])
  })

  it('refuses older runtimes before reading or mutating workspace files', async () => {
    const { client, sendRequest } = clientWithResponses([success({ capabilities: [] })])

    await expect(captureMobileFileMutationOwnership(client, 'id:worktree-1')).rejects.toThrow(
      FILE_MUTATION_OWNERSHIP_UPDATE_REQUIRED_MESSAGE
    )
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })
})
