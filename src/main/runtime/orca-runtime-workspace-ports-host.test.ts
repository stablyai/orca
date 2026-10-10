import './rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeWithListManagedWorktrees } from './orca-runtime-list-managed-worktrees'

const muxes = vi.hoisted(() => new Map<string, { request: ReturnType<typeof vi.fn> }>())
const scanWorkspacePortsMock = vi.hoisted(() => vi.fn())

vi.mock('../ssh/ssh-target-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveMultiplexer: (targetId: string) => muxes.get(targetId)
}))
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
  afterEach(() => {
    muxes.clear()
    scanWorkspacePortsMock.mockReset()
    vi.restoreAllMocks()
  })

  it("scans a folder workspace's SSH host, not this server", async () => {
    const request = vi.fn(async () => ({ platform: 'linux', ports: [{ port: 3020, host: '::' }] }))
    muxes.set('box', { request })
    const runtime = runtimeResolvingTo('ssh:box')

    const result = await runtime.scan('folder:fw-1')

    expect(runtime.host.resolveRuntimeFileTarget).toHaveBeenCalledWith('folder:fw-1')
    expect(request).toHaveBeenCalledWith('ports.detect', undefined, expect.any(Object))
    expect(scanWorkspacePortsMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ executionHostId: 'ssh:box', ports: [{ port: 3020 }] })
  })

  it('answers unavailable for an SSH workspace whose host is not connected', async () => {
    const result = await runtimeResolvingTo('ssh:box').scan('id:repo::/srv/app')

    expect(result.unavailableReason).toMatch(/not connected/)
    expect(scanWorkspacePortsMock).not.toHaveBeenCalled()
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
