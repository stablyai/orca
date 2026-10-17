import './rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeWithListManagedWorktrees } from './workspaces/managed-workspace-operations'
import { RuntimeWorkspaceSelectors } from './workspaces/workspace-selectors'

const scanWorkspacePortsMock = vi.hoisted(() => vi.fn())

vi.mock('../ports/local-workspace-port-scanner', () => ({
  scanWorkspacePorts: scanWorkspacePortsMock
}))

const proto = OrcaRuntimeWithListManagedWorktrees.prototype

function runtimeResolvingTo(executionHostId: string) {
  const host = {
    resolveRuntimeFileTarget: vi.fn(async () => ({ worktree: {}, executionHostId })),
    getWorkspacePortProbes: vi.fn(async () => []),
    getWorkspacePortHostDeps: proto['getWorkspacePortHostDeps']
  }
  return {
    host,
    scan: (selector: string) => proto.scanWorkspacePortsOnHost.call(host, selector),
    kill: (args: Parameters<typeof proto.killWorkspacePortOnHost>[0]) =>
      proto.killWorkspacePortOnHost.call(host, args)
  }
}

describe('host-scoped workspace port scans on the server', () => {
  it('sleeps a host-qualified Windows alias without choosing a foreign or ambiguous row', async () => {
    const id = 'repo::D:/Agentic/game2/battle-core'
    const alias = 'repo::D:\\Agentic\\game2\\battle-core'
    const selected = { id, repoId: 'repo', hostId: 'runtime:hub' }
    let rows = [selected, { ...selected, id: alias, hostId: 'local' }]
    const selectors = RuntimeWorkspaceSelectors.prototype
    const host = {
      store: { getRepo: () => undefined },
      notifier: { sleepWorktree: vi.fn() },
      hasFreshResolvedWorktreeCache: () => true,
      getValidatedExplicitWorktreeIdSelector: selectors['getValidatedExplicitWorktreeIdSelector'],
      resolveWorktreeSelector: selectors['resolveWorktreeSelector'],
      listResolvedWorktrees: async () => rows
    }
    const sleep = () => proto.sleepManagedWorktree.call(host, `id:${alias}`, 'runtime:hub')
    await expect(sleep()).resolves.toEqual({ worktreeId: id, executionHostId: 'runtime:hub' })
    expect(host.notifier.sleepWorktree).toHaveBeenCalledWith(id, 'runtime:hub')
    rows = [selected, { ...selected, id: `${id}/` }]
    await expect(sleep()).rejects.toThrow('selector_ambiguous')
  })

  afterEach(() => {
    scanWorkspacePortsMock.mockReset()
    vi.restoreAllMocks()
  })

  it("reports a folder workspace's SSH host unavailable instead of scanning this server", async () => {
    const runtime = runtimeResolvingTo('ssh:box')

    const result = await runtime.scan('folder:fw-1')

    expect(runtime.host.resolveRuntimeFileTarget).toHaveBeenCalledWith('folder:fw-1')
    expect(scanWorkspacePortsMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ executionHostId: 'ssh:box', ports: [] })
    expect(result.unavailableReason).toMatch(/Reconnect/)
  })

  it('refuses Stop when the workspace now resolves to a different host than the row', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const runtime = runtimeResolvingTo('local')

    const result = await runtime.kill({
      worktree: 'id:repo::/srv/app',
      executionHostId: 'ssh:box',
      pid: 4242,
      port: 3020
    })

    expect(result).toMatchObject({ ok: false })
    expect(kill).not.toHaveBeenCalled()
  })

  it('authorizes Stop only with workspaces this host runs itself', async () => {
    const repos = [
      { id: 'local-repo', path: '/srv/app' },
      // An SSH repo may carry only its execution host, with no legacy connectionId.
      { id: 'ssh-repo', path: '/srv/private', executionHostId: 'ssh:box' },
      { id: 'legacy-ssh-repo', path: '/srv/legacy', connectionId: 'box' },
      { id: 'runtime-repo', path: '/srv/env', executionHostId: 'runtime:env-2' }
    ]
    const worktree = (repoId: string, path: string) => ({
      id: `${repoId}::${path}`,
      repoId,
      displayName: '',
      git: { path }
    })
    const host = {
      requireStore: () => ({ getRepos: () => repos }),
      listResolvedWorktrees: async () => [
        worktree('local-repo', '/srv/app'),
        worktree('ssh-repo', '/srv/private'),
        worktree('legacy-ssh-repo', '/srv/legacy'),
        worktree('runtime-repo', '/srv/env')
      ]
    }

    const probes = await proto['getWorkspacePortProbes'].call(host)

    expect(probes.map((probe) => probe.path)).toEqual(['/srv/app'])
  })
})
