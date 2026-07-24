import { describe, expect, it, vi } from 'vitest'
import type { SshConnectionState } from '../../../src/shared/ssh-types'
import { FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcResponse } from '../transport/types'
import { createAndOpenMobileMarkdownNote } from './mobile-markdown-note-create'

function success(result: unknown, runtimeId = 'runtime-1'): RpcResponse {
  return { id: 'rpc-1', ok: true, result, _meta: { runtimeId } }
}

function failure(message: string, runtimeId = 'runtime-1'): RpcResponse {
  return {
    id: 'rpc-1',
    ok: false,
    error: { code: 'internal', message },
    _meta: { runtimeId }
  }
}

function successWithoutRuntimeMeta(result: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result } as RpcResponse
}

function sshState(generation: number): SshConnectionState {
  return {
    targetId: 'target-1',
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    connectionGeneration: generation
  }
}

function statusResponse(runtimeId = 'runtime-1'): RpcResponse {
  return success({ capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] }, runtimeId)
}

describe('mobile markdown note creation fence', () => {
  it('creates and opens a local note with fresh capability and owner checks', async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return statusResponse()
      }
      if (method === 'worktree.show') {
        return success({ worktree: { hostId: 'local' } })
      }
      return success({ ok: true })
    })

    await expect(createAndOpenMobileMarkdownNote({ sendRequest }, 'id:worktree-1')).resolves.toBe(
      'untitled.md'
    )
    expect(sendRequest).toHaveBeenCalledWith(
      'files.createFile',
      {
        worktree: 'id:worktree-1',
        relativePath: 'untitled.md',
        expectedExecutionHostId: 'local'
      },
      { timeoutMs: 15_000 }
    )
    expect(sendRequest).toHaveBeenCalledWith(
      'files.open',
      { worktree: 'id:worktree-1', relativePath: 'untitled.md' },
      { timeoutMs: 15_000 }
    )
  })

  it('surfaces a files.open failure after a successful create', async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return statusResponse()
      }
      if (method === 'worktree.show') {
        return success({ worktree: { hostId: 'local' } })
      }
      if (method === 'files.createFile') {
        return success({ ok: true })
      }
      if (method === 'files.open') {
        return failure('Cannot open file')
      }
      throw new Error(`Unexpected RPC request: ${method}`)
    })

    await expect(createAndOpenMobileMarkdownNote({ sendRequest }, 'id:worktree-1')).rejects.toThrow(
      'Cannot open file'
    )
  })

  it('rejects a files.open reply from a replacement runtime', async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return statusResponse()
      }
      if (method === 'worktree.show') {
        return success({ worktree: { hostId: 'local' } })
      }
      if (method === 'files.createFile') {
        return success({ ok: true })
      }
      if (method === 'files.open') {
        return success({ opened: true }, 'runtime-new')
      }
      throw new Error(`Unexpected RPC request: ${method}`)
    })

    await expect(createAndOpenMobileMarkdownNote({ sendRequest }, 'id:worktree-1')).rejects.toThrow(
      'Orca server changed'
    )
  })

  it('stops before opening when the transport cuts over after a successful create', async () => {
    let transportGeneration = 1
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return statusResponse()
      }
      if (method === 'worktree.show') {
        return success({ worktree: { hostId: 'local' } })
      }
      if (method === 'files.createFile') {
        transportGeneration = 2
        return success({ ok: true })
      }
      throw new Error(`Unexpected RPC request: ${method}`)
    })
    const client = { sendRequest, getGeneration: () => transportGeneration }

    await expect(createAndOpenMobileMarkdownNote(client, 'id:worktree-1')).rejects.toThrow(
      'Orca server changed'
    )
    expect(sendRequest.mock.calls.some(([method]) => method === 'files.open')).toBe(false)
  })

  it('keeps one SSH ownership lease across name-collision retries', async () => {
    let createAttempts = 0
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return statusResponse()
      }
      if (method === 'worktree.show') {
        return success({ worktree: { hostId: 'ssh:target-1' } })
      }
      if (method === 'ssh.getState') {
        return success({ state: sshState(7) })
      }
      if (method === 'files.createFile') {
        createAttempts += 1
        return createAttempts === 1 ? failure('EEXIST: file already exists') : success({ ok: true })
      }
      return success({ opened: true })
    })

    await expect(createAndOpenMobileMarkdownNote({ sendRequest }, 'id:worktree-1')).resolves.toBe(
      'untitled-2.md'
    )
    const createCalls = sendRequest.mock.calls.filter(([method]) => method === 'files.createFile')
    expect(createCalls.map(([, params]) => params)).toEqual([
      {
        worktree: 'id:worktree-1',
        relativePath: 'untitled.md',
        expectedExecutionHostId: 'ssh:target-1',
        expectedSshTargetId: 'target-1',
        expectedSshConnectionGeneration: 7
      },
      {
        worktree: 'id:worktree-1',
        relativePath: 'untitled-2.md',
        expectedExecutionHostId: 'ssh:target-1',
        expectedSshTargetId: 'target-1',
        expectedSshConnectionGeneration: 7
      }
    ])
    expect(sendRequest.mock.calls.filter(([method]) => method === 'status.get')).toHaveLength(1)
    expect(sendRequest.mock.calls.filter(([method]) => method === 'worktree.show')).toHaveLength(1)
    expect(sendRequest.mock.calls.filter(([method]) => method === 'ssh.getState')).toHaveLength(1)
  })

  it('lets the server reject the original lease after an SSH reconnect', async () => {
    let createAttempts = 0
    const sendRequest = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'status.get') {
        return statusResponse()
      }
      if (method === 'worktree.show') {
        return success({ worktree: { hostId: 'ssh:target-1' } })
      }
      if (method === 'ssh.getState') {
        return success({ state: sshState(7) })
      }
      if (method === 'files.createFile') {
        createAttempts += 1
        if (createAttempts === 1) {
          return failure('EEXIST: file already exists')
        }
        expect(params).toMatchObject({ expectedSshConnectionGeneration: 7 })
        return failure('SSH connection changed; refresh and try again')
      }
      throw new Error(`Unexpected RPC request: ${method}`)
    })

    await expect(createAndOpenMobileMarkdownNote({ sendRequest }, 'id:worktree-1')).rejects.toThrow(
      'SSH connection changed'
    )
    expect(createAttempts).toBe(2)
    expect(sendRequest.mock.calls.filter(([method]) => method === 'ssh.getState')).toHaveLength(1)
    expect(sendRequest.mock.calls.some(([method]) => method === 'files.open')).toBe(false)
  })

  it('stops a collision retry when the logical transport cuts over', async () => {
    let transportGeneration = 1
    let createAttempts = 0
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return statusResponse()
      }
      if (method === 'worktree.show') {
        return success({ worktree: { hostId: 'local' } })
      }
      if (method === 'files.createFile') {
        createAttempts += 1
        transportGeneration = 2
        return failure('EEXIST: file already exists')
      }
      throw new Error(`Unexpected RPC request: ${method}`)
    })
    const client = { sendRequest, getGeneration: () => transportGeneration }

    await expect(createAndOpenMobileMarkdownNote(client, 'id:worktree-1')).rejects.toThrow(
      'Orca server changed'
    )
    expect(createAttempts).toBe(1)
    expect(sendRequest.mock.calls.some(([method]) => method === 'files.open')).toBe(false)
  })

  it('invalidates a collision reply from a replacement runtime', async () => {
    let createAttempts = 0
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return statusResponse('runtime-old')
      }
      if (method === 'worktree.show') {
        return success({ worktree: { hostId: 'local' } }, 'runtime-old')
      }
      if (method === 'files.createFile') {
        createAttempts += 1
        return failure('EEXIST: file already exists', 'runtime-new')
      }
      throw new Error(`Unexpected RPC request: ${method}`)
    })

    await expect(createAndOpenMobileMarkdownNote({ sendRequest }, 'id:worktree-1')).rejects.toThrow(
      'Orca server changed'
    )
    expect(createAttempts).toBe(1)
  })

  it('rejects a mutation reply without runtime metadata', async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return statusResponse()
      }
      if (method === 'worktree.show') {
        return success({ worktree: { hostId: 'local' } })
      }
      if (method === 'files.createFile') {
        return successWithoutRuntimeMeta({ ok: true })
      }
      throw new Error(`Unexpected RPC request: ${method}`)
    })

    await expect(createAndOpenMobileMarkdownNote({ sendRequest }, 'id:worktree-1')).rejects.toThrow(
      'Orca server changed'
    )
    expect(sendRequest.mock.calls.some(([method]) => method === 'files.open')).toBe(false)
  })

  it('does not retry an ambiguous mutation timeout as a filename collision', async () => {
    let createAttempts = 0
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return statusResponse()
      }
      if (method === 'worktree.show') {
        return success({ worktree: { hostId: 'local' } })
      }
      if (method === 'files.createFile') {
        createAttempts += 1
        throw new Error('Request timed out: files.createFile')
      }
      throw new Error(`Unexpected RPC request: ${method}`)
    })

    await expect(createAndOpenMobileMarkdownNote({ sendRequest }, 'id:worktree-1')).rejects.toThrow(
      'Request timed out'
    )
    expect(createAttempts).toBe(1)
    expect(sendRequest.mock.calls.some(([method]) => method === 'files.open')).toBe(false)
  })
})
