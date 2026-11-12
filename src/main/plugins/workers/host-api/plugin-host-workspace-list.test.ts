import { describe, expect, it, vi } from 'vitest'
import { callPluginHost, pluginHostTestServices } from './__mocks__/plugin-host-services-fixture'

const PS_ANSWER = {
  worktrees: [
    {
      worktreeId: 'r1::/src/app',
      identity: { key: 'wt2:local:i1' },
      status: 'working',
      unread: true,
      liveTerminalCount: 2,
      lastOutputAt: 20,
      lastActivityAt: 10
    },
    {
      worktreeId: 'folder:f1',
      status: 'inactive',
      unread: false,
      liveTerminalCount: 0,
      lastOutputAt: null
    }
  ]
}

const ANSWERS: Record<string, unknown> = {
  'worktree.list': {
    worktrees: [
      {
        id: 'r1::/src/app',
        repoId: 'r1',
        displayName: 'app',
        path: '/src/app',
        branch: 'refs/heads/main',
        hostId: 'local',
        identity: { key: 'wt2:local:i1' }
      },
      { id: 'r1::/src/old', repoId: 'r1', displayName: 'old', path: '/src/old' }
    ]
  },
  'repo.list': {
    repos: [
      { id: 'r1', displayName: 'App', path: '/src/app', executionHostId: 'local' },
      { id: 'r2', kind: 'folder', displayName: 'Docs', path: '/docs', connectionId: 'box' },
      { id: 'r3', displayName: 'Lib', path: '/lib' }
    ]
  },
  'folderWorkspace.list': {
    folderWorkspaces: [{ id: 'f1', name: 'Notes', folderPath: '/notes' }]
  },
  'worktree.ps': PS_ANSWER
}

const runtime = () => vi.fn(async (method: string) => ANSWERS[method])
const list = (rpc: ReturnType<typeof runtime>, params: unknown) =>
  callPluginHost({
    method: 'workspace.list',
    params,
    granted: ['workspace:read'],
    services: pluginHostTestServices(rpc)
  })

describe('workspace.list', () => {
  it('names each row by its listed id and project, joining status only when asked', async () => {
    const rpc = runtime()
    const outcome = await list(rpc, { includeStatus: true })
    expect(outcome).toMatchObject({ ok: true })
    expect(outcome.ok && outcome.value).toMatchObject({
      workspaces: [
        {
          id: 'identity:wt2:local:i1',
          projectId: 'r1',
          status: { state: 'working', unread: true, terminalCount: 2, lastActivityAt: 20 }
        },
        { id: 'r1::/src/old', projectId: 'r1' },
        {
          id: 'folder:f1',
          projectId: null,
          status: { state: 'inactive', unread: false, terminalCount: 0, lastActivityAt: null }
        }
      ]
    })
    // A workspace Orca has no status for has none, rather than a guessed one.
    expect(outcome.ok && outcome.value).not.toHaveProperty('workspaces.1.status')

    const plain = runtime()
    const without = await list(plain, {})
    expect(without.ok && without.value).not.toHaveProperty('workspaces.0.status')
    // Why it matters: worktree.ps refreshes every terminal host.
    expect(plain.mock.calls.map(([method]) => method)).not.toContain('worktree.ps')
  })

  it('names hosts as project.list does, and leaves out rows past the bounds', async () => {
    const rpc = vi.fn(async (method: string) =>
      method === 'worktree.list'
        ? {
            worktrees: [
              { id: 'r1::/ok', repoId: 'r1', displayName: 'ok', path: '/ok' },
              { id: 'r1::/long', repoId: 'r1', displayName: 'x', path: `/${'x'.repeat(2000)}` }
            ]
          }
        : ANSWERS[method]
    )
    const outcome = await list(rpc, {})
    expect(outcome.ok && outcome.value).toMatchObject({
      workspaces: [
        { id: 'r1::/ok', hostId: 'local' },
        { id: 'folder:f1', hostId: 'local' }
      ],
      truncated: true
    })
  })

  it('shares one status listing across calls, and says when it stopped short', async () => {
    const rpc = vi.fn(async (method: string) =>
      method === 'worktree.ps'
        ? { ...PS_ANSWER, totalCount: 900, truncated: true }
        : ANSWERS[method]
    )
    const services = pluginHostTestServices(rpc)
    const call = () =>
      callPluginHost({
        method: 'workspace.list',
        params: { includeStatus: true },
        granted: ['workspace:read'],
        services
      })
    const [first, second] = await Promise.all([call(), call()])
    expect(first.ok && first.value).toMatchObject({ statusTruncated: true })
    expect(second).toEqual(first)
    expect(rpc.mock.calls.filter(([method]) => method === 'worktree.ps')).toHaveLength(1)
  })

  it('refuses unknown params, as older hosts refuse includeStatus', async () => {
    expect(await list(runtime(), { includeStatus: true, extra: 1 })).toMatchObject({
      ok: false,
      code: 'invalid_params'
    })
  })
})

describe('project.list', () => {
  it('lists repositories and folders with the host each runs on', async () => {
    const outcome = await callPluginHost({
      method: 'project.list',
      params: {},
      granted: ['workspace:read'],
      services: pluginHostTestServices(runtime())
    })
    expect(outcome).toEqual({
      ok: true,
      value: {
        projects: [
          { id: 'r1', name: 'App', kind: 'git', hostId: 'local', path: '/src/app' },
          { id: 'r2', name: 'Docs', kind: 'folder', hostId: 'ssh:box', path: '/docs' },
          { id: 'r3', name: 'Lib', kind: 'git', hostId: 'local', path: '/lib' }
        ],
        truncated: false
      }
    })
  })
})
