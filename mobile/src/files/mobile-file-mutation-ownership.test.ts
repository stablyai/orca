import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState } from '../../../src/shared/ssh-types'
import {
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  FILE_MUTATION_OWNERSHIP_UPDATE_REQUIRED_MESSAGE
} from '../../../src/shared/protocol-version'
import {
  FILE_MUTATION_OWNER_UNVERIFIED_MESSAGE,
  FILE_MUTATION_RUNTIME_UNVERIFIED_MESSAGE,
  FILE_MUTATION_SSH_UNVERIFIED_MESSAGE
} from '../../../src/shared/file-mutation-ownership'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcResponse } from '../transport/types'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import {
  buildMobileFileMutationOwnership,
  captureMobileFileMutationOwnership,
  getMobileFileMutationFailureMessage,
  MOBILE_WORKTREE_NOT_FOUND_MESSAGE
} from './mobile-file-mutation-ownership'

function success(result: unknown, runtimeId = 'runtime-1'): RpcResponse {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId } }
}

function successWithoutRuntimeMeta(result: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result } as RpcResponse
}

function failure(code: string, message: string): RpcFailure {
  return {
    id: 'rpc-1',
    ok: false,
    error: { code, message },
    _meta: { runtimeId: 'runtime-1' }
  }
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

function sshState(
  targetId: string,
  connectionGeneration: number | undefined,
  status: SshConnectionState['status'] = 'connected'
): SshConnectionState {
  return {
    targetId,
    status,
    error: null,
    reconnectAttempt: 0,
    connectionGeneration
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('mobile file mutation ownership', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('binds a local worktree to the runtime-local file host', () => {
    expect(buildMobileFileMutationOwnership('local')).toEqual({
      expectedExecutionHostId: 'local'
    })
  })

  it.each([undefined, null, '', 'not-an-execution-host', 'ssh:', 'runtime:'])(
    'fails closed when the worktree owner is %s',
    (hostId) => {
      expect(() => buildMobileFileMutationOwnership(hostId)).toThrow(
        FILE_MUTATION_OWNER_UNVERIFIED_MESSAGE
      )
    }
  )

  it('rejects a runtime owner that mobile cannot verify against its paired HUB', () => {
    expect(() => buildMobileFileMutationOwnership('runtime:environment-1')).toThrow(
      FILE_MUTATION_RUNTIME_UNVERIFIED_MESSAGE
    )
  })

  it('binds SSH worktrees to the target and live connection generation', () => {
    expect(
      buildMobileFileMutationOwnership('ssh:target%20one', sshState('target one', 17))
    ).toEqual({
      expectedExecutionHostId: 'ssh:target%20one',
      expectedSshTargetId: 'target one',
      expectedSshConnectionGeneration: 17
    })
  })

  it('canonicalizes equivalent legacy SSH owner encodings', () => {
    expect(buildMobileFileMutationOwnership('ssh:ssh%2D1', sshState('ssh-1', 7))).toEqual({
      expectedExecutionHostId: 'ssh:ssh-1',
      expectedSshTargetId: 'ssh-1',
      expectedSshConnectionGeneration: 7
    })
  })

  it('preserves runtime-owned SSH routing and its connection fence', () => {
    expect(
      buildMobileFileMutationOwnership(
        'ssh:runtime-ssh-environment-1',
        sshState('runtime-ssh-environment-1', 18)
      )
    ).toEqual({
      expectedExecutionHostId: 'ssh:runtime-ssh-environment-1',
      expectedSshTargetId: 'runtime-ssh-environment-1',
      expectedSshConnectionGeneration: 18
    })
  })

  it.each([
    ['a missing SSH state', 'ssh:target-1', null],
    ['a reconnecting SSH state', 'ssh:target-1', sshState('target-1', 4, 'reconnecting')],
    ['a mismatched SSH target', 'ssh:target-1', sshState('target-2', 4)],
    ['a missing SSH generation', 'ssh:target-1', sshState('target-1', undefined)]
  ])('rejects %s', (_name, hostId, state) => {
    expect(() => buildMobileFileMutationOwnership(hostId, state)).toThrow(
      FILE_MUTATION_SSH_UNVERIFIED_MESSAGE
    )
  })

  it('fetches fresh capability and local owner in parallel on one runtime', async () => {
    const status = deferred<RpcResponse>()
    const worktree = deferred<RpcResponse>()
    const sendRequest = vi.fn((method: string) => {
      if (method === 'status.get') {
        return status.promise
      }
      if (method === 'worktree.show') {
        return worktree.promise
      }
      throw new Error(`Unexpected RPC request: ${method}`)
    })
    const capture = captureMobileFileMutationOwnership({ sendRequest }, 'id:worktree-1')

    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'status.get',
      'worktree.show'
    ])
    worktree.resolve(success({ worktree: { hostId: 'local' } }))
    await Promise.resolve()
    expect(sendRequest).toHaveBeenCalledTimes(2)
    status.resolve(success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] }))

    await expect(capture).resolves.toEqual({
      ownership: { expectedExecutionHostId: 'local' },
      runtimeId: 'runtime-1',
      transportGeneration: null
    })
  })

  it('rejects a pre-metadata runtime without surfacing a TypeError', async () => {
    const sendRequest = vi.fn(async (method: string) =>
      method === 'status.get'
        ? successWithoutRuntimeMeta({
            capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY]
          })
        : success({ worktree: { hostId: 'local' } })
    )

    await expect(
      captureMobileFileMutationOwnership({ sendRequest }, 'id:worktree-1')
    ).rejects.toThrow('Orca server changed')
  })

  it('captures SSH generation only after the concurrent owner checks', async () => {
    const state = sshState('target-1', 9)
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] })
      }
      if (method === 'worktree.show') {
        return success({ worktree: { hostId: 'ssh:target-1' } })
      }
      if (method === 'ssh.getState') {
        return success({ state })
      }
      throw new Error(`Unexpected RPC request: ${method}`)
    })

    await expect(
      captureMobileFileMutationOwnership({ sendRequest }, 'id:worktree-1')
    ).resolves.toEqual({
      ownership: {
        expectedExecutionHostId: 'ssh:target-1',
        expectedSshTargetId: 'target-1',
        expectedSshConnectionGeneration: 9
      },
      runtimeId: 'runtime-1',
      transportGeneration: null
    })
    expect(sendRequest.mock.calls[2]).toEqual([
      'ssh.getState',
      { targetId: 'target-1' },
      { timeoutMs: expect.any(Number) }
    ])
  })

  it('refuses older runtimes promptly without reading SSH state', async () => {
    const hangingWorktree = deferred<RpcResponse>()
    const sendRequest = vi.fn((method: string) => {
      if (method === 'status.get') {
        return Promise.resolve(success({ capabilities: [] }))
      }
      if (method === 'worktree.show') {
        return hangingWorktree.promise
      }
      throw new Error(`Unexpected RPC request: ${method}`)
    })

    await expect(
      captureMobileFileMutationOwnership({ sendRequest }, 'id:worktree-1')
    ).rejects.toThrow(FILE_MUTATION_OWNERSHIP_UPDATE_REQUIRED_MESSAGE)
    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'status.get',
      'worktree.show'
    ])
  })

  it('rejects mixed runtime identities before reading SSH state', async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return success(
          { capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] },
          'runtime-old'
        )
      }
      return success({ worktree: { hostId: 'ssh:target-1' } }, 'runtime-new')
    })

    await expect(
      captureMobileFileMutationOwnership({ sendRequest }, 'id:worktree-1')
    ).rejects.toThrow('Orca server changed')
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('rejects an SSH state returned by a replacement runtime', async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] })
      }
      if (method === 'worktree.show') {
        return success({ worktree: { hostId: 'ssh:target-1' } })
      }
      return success({ state: sshState('target-1', 10) }, 'runtime-new')
    })

    await expect(
      captureMobileFileMutationOwnership({ sendRequest }, 'id:worktree-1')
    ).rejects.toThrow('Orca server changed')
    expect(sendRequest).toHaveBeenCalledTimes(3)
  })

  it('restarts the whole read-only capture once after transport cutover', async () => {
    let generation = 1
    let statusCalls = 0
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        statusCalls += 1
        return success(
          { capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] },
          `runtime-${generation}`
        )
      }
      if (method === 'worktree.show' && generation === 1) {
        generation = 2
        throw new LogicalClientCutoverError()
      }
      return success({ worktree: { hostId: 'local' } }, `runtime-${generation}`)
    })
    const client = { sendRequest, getGeneration: () => generation }

    await expect(captureMobileFileMutationOwnership(client, 'id:worktree-1')).resolves.toEqual({
      ownership: { expectedExecutionHostId: 'local' },
      runtimeId: 'runtime-2',
      transportGeneration: 2
    })
    expect(statusCalls).toBe(2)
    expect(sendRequest).toHaveBeenCalledTimes(4)
  })

  it('restarts capability and owner checks after cutover during SSH state', async () => {
    let generation = 1
    const callsByMethod = new Map<string, number>()
    const sendRequest = vi.fn(async (method: string) => {
      callsByMethod.set(method, (callsByMethod.get(method) ?? 0) + 1)
      if (method === 'status.get') {
        return success(
          { capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] },
          `runtime-${generation}`
        )
      }
      if (method === 'worktree.show') {
        return success(
          { worktree: { hostId: generation === 1 ? 'ssh:target-1' : 'local' } },
          `runtime-${generation}`
        )
      }
      generation = 2
      throw new LogicalClientCutoverError()
    })
    const client = { sendRequest, getGeneration: () => generation }

    await expect(captureMobileFileMutationOwnership(client, 'id:worktree-1')).resolves.toEqual({
      ownership: { expectedExecutionHostId: 'local' },
      runtimeId: 'runtime-2',
      transportGeneration: 2
    })
    expect(callsByMethod).toEqual(
      new Map([
        ['status.get', 2],
        ['worktree.show', 2],
        ['ssh.getState', 1]
      ])
    )
  })

  it('does not retry a timed-out preflight and shares one timeout budget', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] })
      }
      if (method === 'worktree.show') {
        vi.setSystemTime(10_000)
        return success({ worktree: { hostId: 'ssh:target-1' } })
      }
      throw new Error('Request timed out: ssh.getState')
    })

    await expect(
      captureMobileFileMutationOwnership({ sendRequest }, 'id:worktree-1')
    ).rejects.toThrow('before the request timed out')
    expect(sendRequest.mock.calls[2]?.[2]).toEqual({ timeoutMs: 5_000 })
    expect(sendRequest).toHaveBeenCalledTimes(3)
  })

  it('normalizes a delivery-unknown transport drop to the preflight timeout message', async () => {
    // Why: relay timeouts / socket drops carry the delivery-unknown marker, not the direct-session
    // timeout strings, so they must still surface the actionable preflight message.
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] })
      }
      throw markRpcDeliveryUnknown(new Error('relay RPC timed out: worktree.show'))
    })

    await expect(
      captureMobileFileMutationOwnership({ sendRequest }, 'id:worktree-1')
    ).rejects.toThrow('before the request timed out')
  })

  it('routes folder workspaces through the folder record instead of worktree.show', async () => {
    const { client, sendRequest } = clientWithResponses([
      success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] }),
      success({ folderWorkspaces: [{ id: 'folder-1', folderPath: '/f', connectionId: null }] }),
      success({ repos: [] }),
      success({ groups: [] })
    ])

    await expect(captureMobileFileMutationOwnership(client, 'id:folder:folder-1')).resolves.toEqual(
      {
        ownership: { expectedExecutionHostId: 'local' },
        runtimeId: 'runtime-1',
        transportGeneration: null
      }
    )
    expect(sendRequest.mock.calls).toEqual([
      ['status.get', undefined, { timeoutMs: expect.any(Number) }],
      ['folderWorkspace.list', undefined, { timeoutMs: expect.any(Number) }],
      ['repo.list', undefined, { timeoutMs: expect.any(Number) }],
      ['projectGroup.list', undefined, { timeoutMs: expect.any(Number) }]
    ])
  })

  it('rejects folder routing metadata returned by a replacement runtime', async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return success(
          { capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] },
          'runtime-old'
        )
      }
      if (method === 'folderWorkspace.list') {
        return success(
          { folderWorkspaces: [{ id: 'folder-1', folderPath: '/f', connectionId: null }] },
          'runtime-old'
        )
      }
      if (method === 'repo.list') {
        return success({ repos: [] }, 'runtime-old')
      }
      return success({ groups: [] }, 'runtime-new')
    })

    await expect(
      captureMobileFileMutationOwnership({ sendRequest }, 'id:folder:folder-1')
    ).rejects.toThrow('Orca server changed')
    expect(sendRequest).toHaveBeenCalledTimes(4)
  })

  it('binds remote folder workspaces to their SSH connection fence', async () => {
    const { client, sendRequest } = clientWithResponses([
      success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] }),
      success({
        folderWorkspaces: [{ id: 'folder-1', folderPath: '/f', connectionId: 'target one' }]
      }),
      success({ repos: [] }),
      success({ groups: [] }),
      success({ state: sshState('target one', 12) })
    ])

    await expect(captureMobileFileMutationOwnership(client, 'id:folder:folder-1')).resolves.toEqual(
      {
        ownership: {
          expectedExecutionHostId: 'ssh:target%20one',
          expectedSshTargetId: 'target one',
          expectedSshConnectionGeneration: 12
        },
        runtimeId: 'runtime-1',
        transportGeneration: null
      }
    )
    expect(sendRequest.mock.calls[4]).toEqual([
      'ssh.getState',
      { targetId: 'target one' },
      { timeoutMs: expect.any(Number) }
    ])
  })

  it('follows the SSH route the host infers for group-scoped folder workspaces', async () => {
    // Why: legacy/group-derived folders inherit their group repos' shared SSH connection.
    const { client } = clientWithResponses([
      success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] }),
      success({
        folderWorkspaces: [
          { id: 'folder-1', folderPath: '/remote/f', projectGroupId: 'group-1', connectionId: null }
        ]
      }),
      success({
        repos: [{ projectGroupId: 'group-1', path: '/remote', connectionId: 'target-1' }]
      }),
      success({ groups: [{ id: 'group-1', parentGroupId: null }] }),
      success({ state: sshState('target-1', 3) })
    ])

    await expect(captureMobileFileMutationOwnership(client, 'id:folder:folder-1')).resolves.toEqual(
      {
        ownership: {
          expectedExecutionHostId: 'ssh:target-1',
          expectedSshTargetId: 'target-1',
          expectedSshConnectionGeneration: 3
        },
        runtimeId: 'runtime-1',
        transportGeneration: null
      }
    )
  })

  it('rejects folder workspaces whose group spans local and SSH routes', async () => {
    const { client, sendRequest } = clientWithResponses([
      success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] }),
      success({
        folderWorkspaces: [
          { id: 'folder-1', folderPath: '/mixed', projectGroupId: 'group-1', connectionId: null }
        ]
      }),
      success({
        repos: [
          { projectGroupId: 'group-1', path: '/mixed/local', connectionId: null },
          { projectGroupId: 'group-1', path: '/mixed/remote', connectionId: 'target-1' }
        ]
      }),
      success({ groups: [{ id: 'group-1', parentGroupId: null }] })
    ])

    await expect(captureMobileFileMutationOwnership(client, 'id:folder:folder-1')).rejects.toThrow(
      FILE_MUTATION_OWNER_UNVERIFIED_MESSAGE
    )
    expect(sendRequest).toHaveBeenCalledTimes(4)
  })

  it('rejects a folder workspace that no longer exists on the host', async () => {
    const { client, sendRequest } = clientWithResponses([
      success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] }),
      success({ folderWorkspaces: [{ id: 'folder-other', folderPath: '/f', connectionId: null }] })
    ])

    await expect(captureMobileFileMutationOwnership(client, 'id:folder:folder-1')).rejects.toThrow(
      MOBILE_WORKTREE_NOT_FOUND_MESSAGE
    )
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('fails closed when a capability-advertising runtime omits the worktree owner', async () => {
    const { client, sendRequest } = clientWithResponses([
      success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] }),
      success({ worktree: {} })
    ])

    await expect(captureMobileFileMutationOwnership(client, 'id:worktree-1')).rejects.toThrow(
      FILE_MUTATION_OWNER_UNVERIFIED_MESSAGE
    )
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('reports a missing worktree result as unverifiable ownership', async () => {
    const { client } = clientWithResponses([
      success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] }),
      success({})
    ])

    await expect(captureMobileFileMutationOwnership(client, 'id:worktree-1')).rejects.toThrow(
      FILE_MUTATION_OWNER_UNVERIFIED_MESSAGE
    )
  })

  it('maps a missing worktree selector to an actionable mobile error', async () => {
    const { client } = clientWithResponses([
      success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] }),
      failure('selector_not_found', 'selector_not_found')
    ])

    await expect(captureMobileFileMutationOwnership(client, 'id:deleted')).rejects.toThrow(
      MOBILE_WORKTREE_NOT_FOUND_MESSAGE
    )
  })

  it('preserves useful RPC failure messages', () => {
    const response = failure('runtime_error', 'File permission denied')
    expect(getMobileFileMutationFailureMessage(response)).toBe('File permission denied')
  })
})
