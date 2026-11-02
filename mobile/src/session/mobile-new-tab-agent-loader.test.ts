import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { FLOATING_WORKSPACE_WORKTREE_ID } from './floating-workspace'
import { WORKSPACE_ON_OTHER_RUNTIME } from '../../../src/shared/protocol-version'
import {
  loadMobileNewTabAgentOptions,
  MobileWorkspaceOnOtherRuntimeError
} from './mobile-new-tab-agent-loader'

async function loadOptions(
  args: Parameters<typeof loadMobileNewTabAgentOptions>[0]
): Promise<unknown[]> {
  return (await loadMobileNewTabAgentOptions(args)).options
}

function createClient(
  handler: (method: string, params?: unknown) => Promise<unknown>
): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
  return {
    sendRequest: vi.fn(handler),
    subscribe: vi.fn(() => () => {})
  } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
}

describe('mobile new-tab agent loading', () => {
  it('detects agents for a folder workspace on its owning host without resolving a repo', async () => {
    const client = createClient(async (method, params) => {
      if (method === 'settings.get') {
        return { ok: true, result: { settings: {} } }
      }
      if (method === 'preflight.detectAgents') {
        expect(params).toEqual({ worktreeId: 'folder:fw-1' })
        return { ok: true, result: ['claude'] }
      }
      throw new Error(`unexpected request: ${method}`)
    })
    await expect(
      loadOptions({
        client,
        worktreeId: 'folder:fw-1',
        hostRefusesOtherRuntime: true
      })
    ).resolves.toEqual([{ agent: 'claude', label: 'Claude' }])
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'preflight.detectAgents',
      'settings.get'
    ])
  })

  function folderClient(args: {
    connectionId?: string | null
    groupConnectionId?: string
    groupExecutionHostId?: string
    executionHostId?: string
    repos?: unknown[]
    groups?: unknown[]
    missing?: boolean
    duplicate?: boolean
    refused?: boolean
  }) {
    return createClient(async (method, params) => {
      if (method === 'settings.get') {
        return { ok: true, result: { settings: {} } }
      }
      if (method === 'folderWorkspace.list') {
        return {
          ok: true,
          result: {
            folderWorkspaces: args.missing
              ? []
              : [
                  {
                    id: 'fw-1',
                    folderPath: '/project',
                    projectGroupId: 'pg-1',
                    connectionId: args.connectionId,
                    executionHostId: args.executionHostId
                  },
                  ...(args.duplicate
                    ? [
                        {
                          id: 'fw-1',
                          folderPath: '/project',
                          projectGroupId: 'pg-1',
                          connectionId: 'other-ssh'
                        }
                      ]
                    : [])
                ]
          }
        }
      }
      if (method === 'projectGroup.list') {
        return {
          ok: true,
          result: {
            groups: args.groups ?? [
              {
                id: 'pg-1',
                connectionId: args.groupConnectionId,
                executionHostId: args.groupExecutionHostId
              }
            ]
          }
        }
      }
      if (method === 'repo.list') {
        return { ok: true, result: { repos: args.repos ?? [] } }
      }
      if (method === 'preflight.detectAgents') {
        expect(params).toEqual({ worktreeId: 'folder:fw-1' })
        return args.refused
          ? { ok: false, error: { code: 'runtime_error', message: WORKSPACE_ON_OTHER_RUNTIME } }
          : { ok: true, result: ['claude'] }
      }
      if (method === 'preflight.detectRemoteAgents') {
        expect(params).toEqual({
          connectionId: args.executionHostId?.startsWith('ssh:')
            ? args.executionHostId.slice(4)
            : (args.connectionId ?? args.groupConnectionId ?? 'repo-ssh')
        })
        return { ok: true, result: ['claude'] }
      }
      throw new Error(`unexpected request: ${method}`)
    })
  }

  it.each([
    ['local', {}, 'preflight.detectAgents'],
    [
      'explicit local pin overrides group SSH and runtime candidates',
      {
        executionHostId: 'local',
        groupConnectionId: 'group-ssh',
        repos: [{ path: '/project/repo', projectGroupId: 'pg-1', executionHostId: 'runtime:other' }]
      },
      'preflight.detectAgents'
    ],
    ['group SSH', { groupConnectionId: 'group-ssh' }, 'preflight.detectRemoteAgents'],
    [
      'workspace connection overrides group runtime',
      { connectionId: 'own-ssh', groupExecutionHostId: 'runtime:other' },
      'preflight.detectRemoteAgents'
    ],
    [
      'workspace SSH override',
      { connectionId: 'own-ssh', groupConnectionId: 'group-ssh' },
      'preflight.detectRemoteAgents'
    ],
    [
      'explicit host pin',
      { executionHostId: 'ssh:pinned', groupConnectionId: 'group-ssh' },
      'preflight.detectRemoteAgents'
    ],
    [
      'inferred repo SSH',
      {
        repos: [{ path: '/project/repo', projectGroupId: 'pg-1', executionHostId: 'ssh:repo-ssh' }]
      },
      'preflight.detectRemoteAgents'
    ]
  ])('resolves an older host folder catalog: %s', async (_label, args, method) => {
    const client = folderClient(args)
    await expect(loadOptions({ client, worktreeId: 'folder:fw-1' })).resolves.toEqual([
      { agent: 'claude', label: 'Claude' }
    ])
    expect(client.sendRequest.mock.calls.at(-1)?.[0]).toBe(method)
  })

  it.each([
    ['missing', { missing: true }],
    ['duplicate identity', { duplicate: true }],
    [
      'duplicate group identity',
      {
        groups: [
          { id: 'pg-1', connectionId: 'first-ssh' },
          { id: 'pg-1', connectionId: 'second-ssh' }
        ]
      }
    ],
    ['group runtime', { groupExecutionHostId: 'runtime:other', groupConnectionId: 'private-ssh' }],
    [
      'inferred runtime',
      {
        repos: [
          {
            path: '/project/repo',
            projectGroupId: 'pg-1',
            executionHostId: 'runtime:other',
            connectionId: 'private-ssh'
          }
        ]
      }
    ],
    [
      'ambiguous',
      {
        repos: [
          { path: '/project/local', projectGroupId: 'pg-1' },
          { path: '/project/remote', projectGroupId: 'pg-1', connectionId: 'ssh-1' }
        ]
      }
    ],
    ['other runtime', { executionHostId: 'runtime:other', connectionId: 'server-private-ssh' }]
  ])('does not probe the wrong host for a %s folder', async (_label, args) => {
    const client = folderClient(args)
    await expect(loadOptions({ client, worktreeId: 'folder:fw-1' })).rejects.toThrow()
    expect(client.sendRequest.mock.calls.some(([method]) => method.startsWith('preflight.'))).toBe(
      false
    )
  })

  it('does not fall back to probing locally when an older host refuses the folder catalog', async () => {
    const client = createClient(async (method) => {
      if (method === 'settings.get') {
        return { ok: true, result: { settings: {} } }
      }
      return { ok: false, error: { code: 'method_not_found', message: 'Unknown method' } }
    })
    await expect(loadOptions({ client, worktreeId: 'folder:fw-1' })).rejects.toThrow(
      'Unknown method'
    )
    expect(client.sendRequest.mock.calls.some(([method]) => method.startsWith('preflight.'))).toBe(
      false
    )
  })

  it.each(['folderWorkspace.list', 'projectGroup.list', 'repo.list'])(
    'never probes after an incompatible legacy %s reply',
    async (failedMethod) => {
      const base = folderClient({})
      const client = createClient(async (method, params) => {
        if (method === failedMethod) {
          return { ok: true, result: null }
        }
        return base.sendRequest(method, params)
      })
      await expect(loadOptions({ client, worktreeId: 'folder:fw-1' })).rejects.toThrow()
      expect(
        client.sendRequest.mock.calls.some(([method]) => method.startsWith('preflight.'))
      ).toBe(false)
    }
  )

  it.each([false, true])(
    'preserves transport failure without a wrong-host retry (modern=%s)',
    async (modern) => {
      const disconnected = new Error('logical client cutover')
      const client = createClient(async (method) => {
        if (method === 'settings.get') {
          return { ok: true, result: { settings: {} } }
        }
        throw disconnected
      })
      await expect(
        loadOptions({
          client,
          worktreeId: 'folder:fw-1',
          hostRefusesOtherRuntime: modern
        })
      ).rejects.toBe(disconnected)
      const methods = client.sendRequest.mock.calls.map(([method]) => method)
      expect(methods).not.toContain('preflight.detectRemoteAgents')
      expect(methods.filter((method) => method === 'preflight.detectAgents')).toHaveLength(
        modern ? 1 : 0
      )
    }
  )

  it('keeps a modern unserved SSH refusal without retrying on the paired host', async () => {
    const client = createClient(async (method) =>
      method === 'settings.get'
        ? { ok: true, result: { settings: {} } }
        : { ok: false, error: { code: 'runtime_error', message: 'SSH host not served' } }
    )
    await expect(
      loadOptions({
        client,
        worktreeId: 'folder:fw-1',
        hostRefusesOtherRuntime: true
      })
    ).rejects.toThrow('SSH host not served')
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'preflight.detectAgents',
      'settings.get'
    ])
  })

  it('preserves a modern host folder ownership refusal', async () => {
    await expect(
      loadOptions({
        client: folderClient({ refused: true }),
        worktreeId: 'folder:fw-1',
        hostRefusesOtherRuntime: true
      })
    ).rejects.toBeInstanceOf(MobileWorkspaceOnOtherRuntimeError)
  })

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
      loadOptions({
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
      loadOptions({
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
      loadOptions({ client, worktreeId: 'repo-1::/srv/worktree' })
    ).rejects.toBeInstanceOf(MobileWorkspaceOnOtherRuntimeError)
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'repo.list',
      'settings.get'
    ])
  })

  // Put another host’s colliding repo id first so its SSH connection cannot accidentally address this host.
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
      loadOptions({
        client: refused,
        worktreeId: 'repo-1::/srv/worktree',
        hostRefusesOtherRuntime: true
      })
    ).rejects.toBeInstanceOf(MobileWorkspaceOnOtherRuntimeError)

    const answered = sharedRepoIdClient(() => ({ ok: true, result: ['claude'] }))
    await expect(
      loadOptions({
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
      loadOptions({ client, worktreeId: 'repo-1::/srv/worktree' })
    ).rejects.toBeInstanceOf(MobileWorkspaceOnOtherRuntimeError)
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'repo.list',
      'settings.get'
    ])
  })

  it('refreshes like desktop, and detects only where the host predates refresh for phones', async () => {
    const client = createClient(async (method) => {
      if (method === 'settings.get') {
        return { ok: true, result: { settings: {} } }
      }
      if (method === 'preflight.refreshAgents') {
        return {
          ok: false,
          error: {
            code: 'forbidden',
            message: "Method 'preflight.refreshAgents' is not available to mobile clients"
          }
        }
      }
      if (method === 'preflight.detectAgents') {
        return { ok: true, result: ['claude'] }
      }
      throw new Error(`unexpected request: ${method}`)
    })
    await expect(
      loadOptions({
        client,
        worktreeId: FLOATING_WORKSPACE_WORKTREE_ID,
        refresh: true
      })
    ).resolves.toEqual([{ agent: 'claude', label: 'Claude' }])
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'preflight.refreshAgents',
      'settings.get',
      'preflight.detectAgents'
    ])
  })
})
