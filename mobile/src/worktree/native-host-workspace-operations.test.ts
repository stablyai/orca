import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { nativeHostWorkspaceOperations } from './native-host-workspace-operations'

describe('native host workspace operations', () => {
  it('does not relay its connection state, so a first failure stays a failure', () => {
    const client = { sendRequest: vi.fn(), notifyForeground: vi.fn(), subscribe: vi.fn() }

    expect(
      nativeHostWorkspaceOperations(client as unknown as RpcClient).connectionStateIsRelayed
    ).toBeUndefined()
  })

  it('maps named reads and mutations to the existing RPC authority', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce({ ok: true, result: { ui: { sortBy: 'recent' } } })
      .mockResolvedValueOnce({ ok: true, result: {} })
      .mockResolvedValueOnce({ ok: true, result: { repos: [{ id: 'repo-1' }] } })
      .mockResolvedValueOnce({ ok: true, result: { worktrees: [{ worktreeId: 'workspace-1' }] } })
      .mockResolvedValueOnce({ ok: true, result: {} })
      .mockResolvedValueOnce({ ok: true, result: {} })
      .mockResolvedValueOnce({ ok: true, result: {} })
      .mockResolvedValueOnce({ ok: true, result: {} })
    const client = {
      sendRequest,
      notifyForeground: vi.fn(),
      subscribe: vi.fn(() => vi.fn())
    } as unknown as RpcClient
    const operations = nativeHostWorkspaceOperations(client)

    await operations.getViewSettings()
    await operations.setViewSettings({ sortBy: 'recent' })
    await operations.listRepos()
    await operations.listWorkspaces(200)
    await operations.setPinned('workspace-1', true)
    await operations.activateWorkspace('workspace-1')
    await operations.sleepWorkspace('workspace-1')
    await expect(operations.removeWorkspace('workspace-1')).resolves.toBe(true)

    expect(sendRequest.mock.calls).toEqual([
      ['ui.get'],
      ['ui.set', { sortBy: 'recent' }],
      ['repo.list'],
      ['worktree.ps', { limit: 200 }],
      ['worktree.set', { worktree: 'id:workspace-1', isPinned: true }],
      [
        'worktree.activate',
        {
          worktree: 'id:workspace-1',
          notifyClients: false,
          navigation: 'caller'
        }
      ],
      ['worktree.sleep', { worktree: 'id:workspace-1' }],
      ['worktree.rm', { worktree: 'id:workspace-1', force: true }]
    ])
  })

  it('filters the generic host event stream into named workspace changes', () => {
    let receive: ((payload: unknown) => void) | undefined
    const unsubscribe = vi.fn()
    const client = {
      sendRequest: vi.fn(),
      notifyForeground: vi.fn(),
      subscribe: vi.fn((_method, _params, listener) => {
        receive = listener
        return unsubscribe
      })
    } as unknown as RpcClient
    const listener = vi.fn()

    const cleanup = nativeHostWorkspaceOperations(client).subscribeChanges(listener)
    receive?.({ type: 'worktreesChanged' })
    receive?.({ type: 'terminalData', secret: 'must-not-forward' })
    cleanup()

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ type: 'worktreesChanged' })
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('polls the catalog with a snapshot token and reuses the confirmed rows when unchanged', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce({
        ok: true,
        result: { snapshotId: 'snap-1', worktrees: [{ worktreeId: 'workspace-1' }] }
      })
      .mockResolvedValueOnce({ ok: true, result: { snapshotId: 'snap-1', unchanged: true } })
    const operations = nativeHostWorkspaceOperations({
      sendRequest,
      notifyForeground: vi.fn(),
      subscribe: vi.fn()
    } as unknown as RpcClient)

    const first = await operations.fetchWorkspaceCatalog!('host-1')
    const firstRows = first.kind === 'response' ? first.commit() : null
    const second = await operations.fetchWorkspaceCatalog!('host-1')
    const secondRows = second.kind === 'response' ? second.commit() : null

    expect(sendRequest.mock.calls).toEqual([
      ['worktree.ps', { limit: 10_000, afterSnapshotId: null }],
      ['worktree.ps', { limit: 10_000, afterSnapshotId: 'snap-1' }]
    ])
    expect(firstRows).toEqual([{ worktreeId: 'workspace-1' }])
    // Why (bandwidth over relay): an unchanged reply still reasserts the confirmed rows.
    expect(secondRows).toEqual([{ worktreeId: 'workspace-1' }])
  })

  // Why (STA-3123): the host's own code has to survive, or an unreachable remote host
  // is indistinguishable from a healthy host with zero workspaces.
  it('passes the host error code through instead of collapsing it', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValue({ ok: false, error: { code: 'worktree_list_unavailable', message: 'x' } })
    const operations = nativeHostWorkspaceOperations({
      sendRequest,
      notifyForeground: vi.fn(),
      subscribe: vi.fn()
    } as unknown as RpcClient)

    await expect(operations.fetchWorkspaceCatalog!('host-1')).resolves.toEqual({
      kind: 'request_failed',
      code: 'worktree_list_unavailable'
    })
  })

  it('reads ssh labels, host overrides and platform for multi-host catalogs', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockImplementation(async (method: string) => {
        if (method === 'ssh.listTargetSummaries') {
          return { ok: true, result: { targets: [{ id: 'ssh-1', label: 'Build box' }, { id: 7 }] } }
        }
        if (method === 'settings.get') {
          return { ok: true, result: { settings: { hostSettingOverrides: { 'ssh:ssh-1': {} } } } }
        }
        return { ok: true, result: { platform: 'linux' } }
      })
    const operations = nativeHostWorkspaceOperations({
      sendRequest,
      notifyForeground: vi.fn(),
      subscribe: vi.fn()
    } as unknown as RpcClient)

    await expect(operations.listHostContext!()).resolves.toEqual({
      sshTargets: [{ id: 'ssh-1', label: 'Build box' }],
      hostSettingOverrides: { 'ssh:ssh-1': {} },
      platform: 'linux'
    })
  })

  // Hosts that predate a method still list repos; labels degrade to host ids.
  it('degrades host context when the older host rejects or drops the calls', async () => {
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockImplementation(async () => {
      throw new Error('unknown method')
    })
    const operations = nativeHostWorkspaceOperations({
      sendRequest,
      notifyForeground: vi.fn(),
      subscribe: vi.fn()
    } as unknown as RpcClient)

    await expect(operations.listHostContext!()).resolves.toEqual({
      sshTargets: [],
      hostSettingOverrides: undefined,
      platform: null
    })
  })
})
