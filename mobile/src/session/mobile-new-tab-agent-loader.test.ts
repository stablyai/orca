import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { FLOATING_WORKSPACE_WORKTREE_ID } from './floating-workspace'
import { WORKSPACE_ON_OTHER_RUNTIME } from '../../../src/shared/protocol-version'
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

  // Rows on two hosts share the id; the SSH row first, so its connection would name this host's target.
  function sharedRepoIdClient(detectAgents: () => unknown) {
    return createClient(async (method, params) => {
      if (method === 'settings.get') {
        return { ok: true, result: { settings: {} } }
      }
      if (method === 'repo.list') {
        return {
          ok: true,
          result: {
            repos: [
              { id: 'repo-1', executionHostId: 'ssh:a-target', connectionId: 'a-target' },
              { id: 'repo-1', executionHostId: 'runtime:env-b' }
            ]
          }
        }
      }
      if (method === 'preflight.detectAgents') {
        expect(params).toEqual({ worktreeId: 'repo-1::/srv/worktree' })
        return detectAgents()
      }
      throw new Error(`unexpected request: ${method}`)
    })
  }

  it('#13752: lets a refusing host decide a shared repo id, and reads its refusal', async () => {
    const refused = sharedRepoIdClient(() => ({
      ok: false,
      error: { code: 'runtime_error', message: WORKSPACE_ON_OTHER_RUNTIME }
    }))
    await expect(
      loadMobileNewTabAgentOptions({
        client: refused,
        worktreeId: 'repo-1::/srv/worktree',
        hostRefusesOtherRuntime: true
      })
    ).rejects.toBeInstanceOf(MobileWorkspaceOnOtherRuntimeError)

    const answered = sharedRepoIdClient(() => ({ ok: true, result: ['claude'] }))
    await expect(
      loadMobileNewTabAgentOptions({
        client: answered,
        worktreeId: 'repo-1::/srv/worktree',
        hostRefusesOtherRuntime: true
      })
    ).resolves.toEqual([{ agent: 'claude', label: 'Claude' }])
    expect(answered.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'repo.list',
      'settings.get',
      'preflight.detectAgents'
    ])
  })

  it('#13752: an older host cannot decide a shared repo id, so nothing is probed', async () => {
    const client = sharedRepoIdClient(() => ({ ok: true, result: ['codex'] }))
    await expect(
      loadMobileNewTabAgentOptions({ client, worktreeId: 'repo-1::/srv/worktree' })
    ).rejects.toBeInstanceOf(MobileWorkspaceOnOtherRuntimeError)
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'repo.list',
      'settings.get'
    ])
  })
})
