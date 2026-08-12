import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { FLOATING_WORKSPACE_WORKTREE_ID } from './floating-workspace'
import { loadMobileNewTabAgentOptions } from './mobile-new-tab-agent-loader'

function createClient(
  handler: (method: string, params?: unknown) => Promise<unknown>
): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
  return {
    sendRequest: vi.fn(handler),
    subscribe: vi.fn(() => () => {})
  } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
}

describe('mobile new-tab agent loading', () => {
  it('detects agents locally for the floating workspace without listing repos', async () => {
    const client = createClient(async (method) => {
      if (method === 'settings.get') {
        return {
          ok: true,
          result: { settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] } }
        }
      }
      if (method === 'preflight.detectAgents') {
        return { ok: true, result: ['claude', 'codex'] }
      }
      throw new Error(`unexpected request: ${method}`)
    })

    await expect(
      loadMobileNewTabAgentOptions({
        client,
        worktreeId: FLOATING_WORKSPACE_WORKTREE_ID
      })
    ).resolves.toEqual([
      { agent: 'codex', label: 'Codex' },
      { agent: 'claude', label: 'Claude' }
    ])
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'preflight.detectAgents',
      'settings.get'
    ])
  })

  it('detects agents through the worktree repo connection for SSH sessions', async () => {
    const client = createClient(async (method, params) => {
      if (method === 'settings.get') {
        return { ok: true, result: { settings: {} } }
      }
      if (method === 'repo.list') {
        return { ok: true, result: { repos: [{ id: 'repo-1', connectionId: 'ssh-1' }] } }
      }
      if (method === 'preflight.detectRemoteAgents') {
        expect(params).toEqual({ connectionId: 'ssh-1' })
        return { ok: true, result: ['claude'] }
      }
      throw new Error(`unexpected request: ${method}`)
    })

    await expect(
      loadMobileNewTabAgentOptions({
        client,
        worktreeId: 'repo-1::/remote/worktree'
      })
    ).resolves.toEqual([{ agent: 'claude', label: 'Claude' }])
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'repo.list',
      'settings.get',
      'preflight.detectRemoteAgents'
    ])
  })

  it('detects agents on the runtime execution owner, not the paired host', async () => {
    const client = createClient(async (method, params) => {
      if (method === 'settings.get') {
        return { ok: true, result: { settings: {} } }
      }
      if (method === 'repo.list') {
        return {
          ok: true,
          result: {
            repos: [
              {
                id: 'repo-runtime',
                connectionId: null,
                executionHostId: 'runtime:env-headless'
              }
            ]
          }
        }
      }
      if (method === 'preflight.detectRuntimeAgents') {
        expect(params).toEqual({ environmentId: 'env-headless' })
        return { ok: true, result: ['pi'] }
      }
      if (method === 'preflight.detectAgents') {
        throw new Error('must not probe the paired host for a runtime-owned repo')
      }
      throw new Error(`unexpected request: ${method}`)
    })

    await expect(
      loadMobileNewTabAgentOptions({
        client,
        worktreeId: 'repo-runtime::/runtime/worktree'
      })
    ).resolves.toEqual([{ agent: 'pi', label: 'Pi' }])
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'repo.list',
      'settings.get',
      'preflight.detectRuntimeAgents'
    ])
  })

  it('prefers executionHostId over connectionId for SSH-stamped repos', async () => {
    const client = createClient(async (method, params) => {
      if (method === 'settings.get') {
        return { ok: true, result: { settings: {} } }
      }
      if (method === 'repo.list') {
        return {
          ok: true,
          result: {
            repos: [
              {
                id: 'repo-ssh',
                connectionId: 'stale-conn',
                executionHostId: 'ssh:ssh-target-1'
              }
            ]
          }
        }
      }
      if (method === 'preflight.detectRemoteAgents') {
        expect(params).toEqual({ connectionId: 'ssh-target-1' })
        return { ok: true, result: ['codex'] }
      }
      throw new Error(`unexpected request: ${method}`)
    })

    await expect(
      loadMobileNewTabAgentOptions({
        client,
        worktreeId: 'repo-ssh::/ssh/worktree'
      })
    ).resolves.toEqual([{ agent: 'codex', label: 'Codex' }])
  })

  it('falls back to paired-host detection when the host predates detectRuntimeAgents', async () => {
    const client = createClient(async (method) => {
      if (method === 'settings.get') {
        return { ok: true, result: { settings: {} } }
      }
      if (method === 'repo.list') {
        return {
          ok: true,
          result: {
            repos: [
              {
                id: 'repo-runtime',
                connectionId: null,
                executionHostId: 'runtime:env-headless'
              }
            ]
          }
        }
      }
      if (method === 'preflight.detectRuntimeAgents') {
        return {
          ok: false,
          error: { code: 'method_not_found', message: 'Unknown method' },
          _meta: { runtimeId: 'host' }
        }
      }
      if (method === 'preflight.detectAgents') {
        return { ok: true, result: ['claude'] }
      }
      throw new Error(`unexpected request: ${method}`)
    })

    await expect(
      loadMobileNewTabAgentOptions({
        client,
        worktreeId: 'repo-runtime::/runtime/worktree'
      })
    ).resolves.toEqual([{ agent: 'claude', label: 'Claude' }])
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'repo.list',
      'settings.get',
      'preflight.detectRuntimeAgents',
      'preflight.detectAgents'
    ])
  })

  it('detects agents on the paired host for local repos', async () => {
    const client = createClient(async (method) => {
      if (method === 'settings.get') {
        return { ok: true, result: { settings: {} } }
      }
      if (method === 'repo.list') {
        return {
          ok: true,
          result: { repos: [{ id: 'repo-local', connectionId: null, executionHostId: 'local' }] }
        }
      }
      if (method === 'preflight.detectAgents') {
        return { ok: true, result: ['codex'] }
      }
      throw new Error(`unexpected request: ${method}`)
    })

    await expect(
      loadMobileNewTabAgentOptions({
        client,
        worktreeId: 'repo-local::/local/worktree'
      })
    ).resolves.toEqual([{ agent: 'codex', label: 'Codex' }])
  })
})
