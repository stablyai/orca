import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { createBlankWorkspace } from './blank-workspace-create'

type Call = { method: string; params: unknown }

function fakeClient(script: (method: string, call: number) => unknown, calls: Call[]): RpcClient {
  return {
    sendRequest: async (method: string, params?: unknown) => {
      calls.push({ method, params })
      const result = script(method, calls.length)
      if (result instanceof Error) {
        return {
          id: '1',
          ok: false,
          error: { code: 'x', message: result.message },
          _meta: { runtimeId: 'r' }
        }
      }
      return { id: '1', ok: true, result, _meta: { runtimeId: 'r' } }
    }
  } as unknown as RpcClient
}

describe('createBlankWorkspace', () => {
  it('assembles exactly the params the modal historically sent, omitting empty extras', async () => {
    const calls: Call[] = []
    const client = fakeClient(() => ({ worktree: { id: 'wt-1' } }), calls)

    const result = await createBlankWorkspace({
      client,
      repoId: 'repo-1',
      baseName: 'octopus',
      startupCommand: undefined,
      createdWithAgentId: undefined,
      comment: undefined,
      setupDecision: 'inherit'
    })

    expect(result).toEqual({ worktreeId: 'wt-1', name: 'octopus' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      method: 'worktree.create',
      params: {
        repo: 'id:repo-1',
        startupCommand: undefined,
        setupDecision: 'inherit',
        name: 'octopus'
      }
    })
    const params = calls[0]?.params as Record<string, unknown>
    expect('createdWithAgent' in params).toBe(false)
    expect('comment' in params).toBe(false)
  })

  it('includes createdWithAgent and comment only when provided', async () => {
    const calls: Call[] = []
    const client = fakeClient(() => ({ worktree: { id: 'wt-2' } }), calls)

    await createBlankWorkspace({
      client,
      repoId: 'repo-2',
      baseName: 'manatee',
      startupCommand: 'claude',
      createdWithAgentId: 'claude',
      comment: 'spike',
      setupDecision: 'run'
    })

    expect(calls[0]?.params).toMatchObject({
      repo: 'id:repo-2',
      name: 'manatee',
      startupCommand: 'claude',
      setupDecision: 'run',
      createdWithAgent: 'claude',
      comment: 'spike'
    })
  })

  it('retries with a numeric suffix on a branch-collision error', async () => {
    const calls: Call[] = []
    const client = fakeClient((_method, call) => {
      if (call === 1) {
        return new Error('Branch "octopus" already exists locally. Pick a different branch name.')
      }
      return { worktree: { id: 'wt-3' } }
    }, calls)

    const result = await createBlankWorkspace({
      client,
      repoId: 'repo-1',
      baseName: 'octopus',
      startupCommand: undefined,
      createdWithAgentId: undefined,
      comment: undefined,
      setupDecision: 'inherit'
    })

    expect(result).toEqual({ worktreeId: 'wt-3', name: 'octopus-2' })
    expect(calls).toHaveLength(2)
    const retryParams = calls[1]?.params as Record<string, unknown>
    expect(retryParams.name).toBe('octopus-2')
  })

  it('retries on the bare older-runtime collision message', async () => {
    const calls: Call[] = []
    const client = fakeClient((_method, call) => {
      if (call === 1) {
        return new Error('Branch "octopus" already exists.')
      }
      return { worktree: { id: 'wt-4' } }
    }, calls)

    const result = await createBlankWorkspace({
      client,
      repoId: 'repo-1',
      baseName: 'octopus',
      startupCommand: undefined,
      createdWithAgentId: undefined,
      comment: undefined,
      setupDecision: 'inherit'
    })

    expect(result).toEqual({ worktreeId: 'wt-4', name: 'octopus-2' })
    expect(calls).toHaveLength(2)
  })

  it('surfaces a non-collision error without retrying', async () => {
    const calls: Call[] = []
    const client = fakeClient(() => new Error('SSH connection is not available'), calls)

    const result = await createBlankWorkspace({
      client,
      repoId: 'repo-1',
      baseName: 'octopus',
      startupCommand: undefined,
      createdWithAgentId: undefined,
      comment: undefined,
      setupDecision: 'skip'
    })

    expect(result).toEqual({ error: 'SSH connection is not available' })
    expect(calls).toHaveLength(1)
  })
})
