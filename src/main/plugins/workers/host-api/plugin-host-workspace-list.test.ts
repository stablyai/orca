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

describe('workspace.list', () => {
  it('shares a slow listing however long it takes, then keeps its answer for a second', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const slow = Promise.withResolvers<unknown>()
    const rpc = vi.fn(async (method: string) =>
      method === 'worktree.ps' ? slow.promise : ANSWERS[method]
    )
    const services = pluginHostTestServices(rpc)
    const call = () =>
      callPluginHost({
        method: 'workspace.list',
        params: { includeStatus: true },
        granted: ['workspace:read'],
        services
      })
    const psCalls = () => rpc.mock.calls.filter(([method]) => method === 'worktree.ps').length
    const first = call()
    now = 5000
    const second = call()
    slow.resolve(PS_ANSWER)
    expect(await Promise.all([first, second])).toMatchObject([{ ok: true }, { ok: true }])
    expect(psCalls()).toBe(1)
    now = 5900
    await call()
    expect(psCalls()).toBe(1)
    now = 6100
    await call()
    expect(psCalls()).toBe(2)
    vi.restoreAllMocks()
  })
})
