import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { FLOATING_WORKSPACE_WORKTREE_ID } from './floating-workspace'
import { WORKSPACE_ON_OTHER_RUNTIME } from '../../../src/shared/agent-detection-refusal'
import {
  loadMobileNewTabAgentOptions,
  MobileWorkspaceOnOtherRuntimeError
} from './mobile-new-tab-agent-loader'

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

  it('#13752: names another runtime instead of listing the paired host for its workspace', async () => {
    const client = createClient(async (method) => {
      if (method === 'settings.get') {
        return { ok: true, result: { settings: {} } }
      }
      if (method === 'repo.list') {
        return {
          ok: true,
          result: {
            repos: [{ id: 'repo-1', executionHostId: 'runtime:env-b', connectionId: 'b-ssh' }]
          }
        }
      }
      throw new Error(`unexpected request: ${method}`)
    })

    await expect(
      loadMobileNewTabAgentOptions({ client, worktreeId: 'repo-1::/srv/worktree' })
    ).rejects.toBeInstanceOf(MobileWorkspaceOnOtherRuntimeError)
    // Neither the paired host nor its SSH targets are probed for a workspace it does not own.
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'repo.list',
      'settings.get'
    ])
  })

  it("#13752: reads the host's other-runtime refusal as the same answer", async () => {
    const client = createClient(async (method) => {
      if (method === 'settings.get') {
        return { ok: true, result: { settings: {} } }
      }
      if (method === 'repo.list') {
        // Rows on two hosts share the id, so only the host can tell which owns the worktree.
        return {
          ok: true,
          result: {
            repos: [
              { id: 'repo-1', executionHostId: 'runtime:env-b' },
              { id: 'repo-1', executionHostId: 'local' }
            ]
          }
        }
      }
      if (method === 'preflight.detectAgents') {
        return {
          ok: false,
          error: { code: 'runtime_error', message: WORKSPACE_ON_OTHER_RUNTIME }
        }
      }
      throw new Error(`unexpected request: ${method}`)
    })

    await expect(
      loadMobileNewTabAgentOptions({ client, worktreeId: 'repo-1::/srv/worktree' })
    ).rejects.toBeInstanceOf(MobileWorkspaceOnOtherRuntimeError)
  })
})
