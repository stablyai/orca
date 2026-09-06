import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebSessionOperation } from './mobile-web-session-operations'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'

describe('mobile web session operations', () => {
  it('returns only reviewed booleans from the complete host capability list', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
      ok: true,
      result: {
        capabilities: [
          'browser.screencast.v1',
          'aiVault.v1',
          'terminal.quick-commands.v1',
          'terminal.query-reply-input.v1',
          'secret.unreviewed.v1'
        ]
      }
    })

    await expect(
      executeMobileWebSessionOperation({
        operation: 'capabilities',
        payload: {},
        requestId: 'R'.repeat(22),
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority: createWorkspaceAuthority(),
        browserAuthority: createBrowserAuthority(),
        nativeChatAuthority: createNativeChatAuthority()
      })
    ).resolves.toEqual({
      browserScreencastSupported: true,
      agentHistorySupported: true,
      quickCommandsSupported: true,
      terminalQueryReplyInputSupported: true
    })
    expect(sendRequest).toHaveBeenCalledWith('status.get')
  })

  it('rejects the complete capability array when any entry is malformed', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
      ok: true,
      result: {
        capabilities: ['aiVault.v1', 'terminal.quick-commands.v1', 42, 'x'.repeat(121)],
        floatingWorkspaceEnabled: true,
        pairedDeviceId: 'secret-device',
        deviceToken: 'secret-token',
        protocolVersion: 99
      }
    })

    await expect(
      executeMobileWebSessionOperation({
        operation: 'capabilities',
        payload: { includeHostGates: true },
        requestId: 'R'.repeat(22),
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority: createWorkspaceAuthority(),
        browserAuthority: createBrowserAuthority(),
        nativeChatAuthority: createNativeChatAuthority()
      })
    ).resolves.toEqual({
      hostCapabilities: [],
      floatingWorkspaceEnabled: true
    })
  })

  it('keeps the legacy capability response unchanged for old pages', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
      ok: true,
      result: {
        capabilities: ['browser.screencast.v1', 'aiVault.v1'],
        floatingWorkspaceEnabled: true
      }
    })

    await expect(
      executeMobileWebSessionOperation({
        operation: 'capabilities',
        payload: {},
        requestId: 'R'.repeat(22),
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority: createWorkspaceAuthority(),
        browserAuthority: createBrowserAuthority(),
        nativeChatAuthority: createNativeChatAuthority()
      })
    ).resolves.toEqual({
      browserScreencastSupported: true,
      agentHistorySupported: true,
      quickCommandsSupported: false,
      terminalQueryReplyInputSupported: false
    })
  })

  it('exposes a typed refusal without leaking host close metadata', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
      ok: true,
      result: {
        closed: true,
        refused: true,
        refusalReason: 'live-host-pty',
        snapshotRepublished: true,
        terminal: 'secret-handle'
      }
    })
    const workspaceAuthority = createWorkspaceAuthority()
    const workspaceId = workspaceAuthority.pageWorkspaceId('workspace-1')

    await expect(
      executeMobileWebSessionOperation({
        operation: 'close',
        payload: { workspaceId, tabId: 'terminal-1' },
        requestId: 'R'.repeat(22),
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority,
        browserAuthority: createBrowserAuthority(),
        nativeChatAuthority: createNativeChatAuthority()
      })
    ).resolves.toEqual({
      workspaceId,
      tabId: 'terminal-1',
      outcome: 'refused',
      refusalReason: 'live-host-pty'
    })
  })

  it('fails closed when a host mutation returns an unknown result shape', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue({
      ok: true,
      result: {
        closed: true,
        refused: true,
        refusalReason: 'future-unreviewed-reason'
      }
    })
    const workspaceAuthority = createWorkspaceAuthority()
    const workspaceId = workspaceAuthority.pageWorkspaceId('workspace-1')

    await expect(
      executeMobileWebSessionOperation({
        operation: 'close',
        payload: { workspaceId, tabId: 'terminal-1' },
        requestId: 'R'.repeat(22),
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority,
        browserAuthority: createBrowserAuthority(),
        nativeChatAuthority: createNativeChatAuthority()
      })
    ).rejects.toMatchObject({ code: 'host_error' })
  })

  it('freshly verifies detected agent authority before creating a terminal', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method) => {
      if (method === 'repo.list') {
        return { ok: true, result: { repos: [{ id: 'workspace-1', connectionId: null }] } }
      }
      if (method === 'settings.get') {
        return {
          ok: true,
          result: { settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] } }
        }
      }
      if (method === 'preflight.detectAgents') {
        return { ok: true, result: ['codex'] }
      }
      if (method === 'session.tabs.createTerminal') {
        return {
          ok: true,
          result: { tab: { id: 'terminal-1', type: 'terminal' }, terminal: 'secret-handle' }
        }
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const workspaceAuthority = createWorkspaceAuthority()
    const workspaceId = workspaceAuthority.pageWorkspaceId('workspace-1')
    const args = {
      requestId: 'R'.repeat(22),
      client: { sendRequest } as unknown as RpcClient,
      workspaceAuthority,
      browserAuthority: createBrowserAuthority(),
      nativeChatAuthority: createNativeChatAuthority()
    }

    await expect(
      executeMobileWebSessionOperation({
        ...args,
        operation: 'agentOptions',
        payload: { workspaceId }
      })
    ).resolves.toEqual({ agents: ['codex'] })
    await expect(
      executeMobileWebSessionOperation({
        ...args,
        operation: 'createAgent',
        payload: { workspaceId, agent: 'codex' }
      })
    ).resolves.toEqual({
      workspaceId,
      tabId: 'terminal-1',
      created: true
    })
    expect(sendRequest).toHaveBeenCalledWith('session.tabs.createTerminal', {
      worktree: 'id:workspace-1',
      agent: 'codex',
      activate: true,
      select: true,
      navigation: 'caller',
      clientMutationId: 'R'.repeat(22)
    })
  })

  it('rejects an agent that is no longer enabled or detected', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method) => {
      if (method === 'repo.list') {
        return { ok: true, result: { repos: [{ id: 'workspace-1', connectionId: null }] } }
      }
      if (method === 'settings.get') {
        return { ok: true, result: { settings: { defaultTuiAgent: 'codex' } } }
      }
      return { ok: true, result: ['codex'] }
    })
    const workspaceAuthority = createWorkspaceAuthority()
    const workspaceId = workspaceAuthority.pageWorkspaceId('workspace-1')

    await expect(
      executeMobileWebSessionOperation({
        operation: 'createAgent',
        payload: { workspaceId, agent: 'claude' },
        requestId: 'R'.repeat(22),
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority,
        browserAuthority: createBrowserAuthority(),
        nativeChatAuthority: createNativeChatAuthority()
      })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(sendRequest).not.toHaveBeenCalledWith('session.tabs.createTerminal', expect.anything())
  })
})

function createWorkspaceAuthority(): MobileWebWorkspaceAuthority {
  const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length))
  authority.synchronize([{ workspaceId: 'workspace-1', repoId: 'repo-1' }])
  return authority
}

function createBrowserAuthority(): MobileWebBrowserAuthority {
  return new MobileWebBrowserAuthority((length) => new Uint8Array(length))
}

function createNativeChatAuthority(): MobileWebNativeChatAuthority {
  return new MobileWebNativeChatAuthority((length) => new Uint8Array(length))
}
