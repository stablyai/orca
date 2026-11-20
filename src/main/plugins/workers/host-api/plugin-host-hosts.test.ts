import { describe, expect, it, vi } from 'vitest'
import { callPluginHost, pluginHostTestServices } from './__mocks__/plugin-host-services-fixture'

describe('host.list', () => {
  it('lists this computer and each saved SSH target by its ssh: host id', async () => {
    const runtimeRpc = vi.fn().mockResolvedValue({
      targets: [
        { id: 'ssh-1', label: 'Build box', connected: true },
        { id: 'ssh-2', label: 'main.api.alice.coder' }
      ]
    })

    const outcome = await callPluginHost({
      method: 'host.list',
      params: {},
      granted: ['workspace:read'],
      services: pluginHostTestServices(runtimeRpc)
    })

    expect(runtimeRpc).toHaveBeenCalledWith('ssh.listTargetSummaries', {}, undefined)
    expect(outcome).toEqual({
      ok: true,
      value: {
        hosts: [
          { hostId: 'local', kind: 'local', name: 'This computer', connected: true },
          { hostId: 'ssh:ssh-1', kind: 'ssh', name: 'Build box', connected: true },
          { hostId: 'ssh:ssh-2', kind: 'ssh', name: 'main.api.alice.coder', connected: false }
        ],
        truncated: false
      }
    })
  })
})

describe('host.addSshTarget', () => {
  it('saves the target as Settings does and answers its ssh: host id', async () => {
    const runtimeRpc = vi.fn().mockResolvedValue({ target: { id: 'ssh-9' } })

    const outcome = await callPluginHost({
      method: 'host.addSshTarget',
      params: {
        name: 'api',
        host: 'main.api.alice.coder',
        proxyCommand: 'coder ssh --stdio alice/api'
      },
      granted: ['host:write'],
      services: pluginHostTestServices(runtimeRpc)
    })

    expect(runtimeRpc).toHaveBeenCalledWith(
      'ssh.addTarget',
      {
        target: {
          label: 'api',
          configHost: 'main.api.alice.coder',
          host: 'main.api.alice.coder',
          port: 22,
          username: '',
          proxyCommand: 'coder ssh --stdio alice/api'
        }
      },
      expect.objectContaining({ plugin: expect.anything() })
    )
    expect(outcome).toEqual({ ok: true, value: { hostId: 'ssh:ssh-9' } })
  })

  it('needs host:write, not workspace:write', async () => {
    const runtimeRpc = vi.fn()

    const outcome = await callPluginHost({
      method: 'host.addSshTarget',
      params: { name: 'api', host: 'api.example.com' },
      granted: ['workspace:write'],
      services: pluginHostTestServices(runtimeRpc)
    })

    expect(outcome).toMatchObject({ ok: false, code: 'capability_denied' })
    expect(runtimeRpc).not.toHaveBeenCalled()
  })
})

describe('host.connect', () => {
  it('connects the SSH target the host id names', async () => {
    const runtimeRpc = vi.fn().mockResolvedValue({ state: { status: 'connected' } })

    const outcome = await callPluginHost({
      method: 'host.connect',
      params: { hostId: 'ssh:ssh-9' },
      granted: ['host:write'],
      services: pluginHostTestServices(runtimeRpc)
    })

    expect(runtimeRpc).toHaveBeenCalledWith(
      'ssh.connect',
      { targetId: 'ssh-9' },
      expect.objectContaining({ plugin: expect.anything() })
    )
    expect(outcome).toEqual({ ok: true, value: { connected: true } })
  })
})

describe('project.add', () => {
  it('adds a folder on an SSH host through the Orca server that host runs', async () => {
    const runtimeRpc = vi.fn().mockResolvedValue({
      state: { status: 'connected', managedServer: { kind: 'managed', environmentId: 'env-7' } }
    })
    const environmentRpc = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: { repos: [] } })
      .mockResolvedValueOnce({ ok: true, result: { repo: { id: 'repo-1' } } })

    const outcome = await callPluginHost({
      method: 'project.add',
      params: { hostId: 'ssh:ssh-9', path: '/home/coder/api', name: 'API' },
      granted: ['workspace:write'],
      services: pluginHostTestServices(runtimeRpc, { environmentRpc })
    })

    expect(runtimeRpc).toHaveBeenCalledWith('ssh.getState', { targetId: 'ssh-9' }, undefined)
    expect(environmentRpc).toHaveBeenLastCalledWith(
      'env-7',
      'repo.add',
      { path: '/home/coder/api', displayName: 'API' },
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
    expect(outcome).toEqual({
      ok: true,
      value: { projectId: 'repo-1', hostId: 'runtime:env-7', created: true }
    })
  })

  it('refuses an SSH host that is not connected, without adding anything', async () => {
    const runtimeRpc = vi.fn().mockResolvedValue({ state: { status: 'disconnected' } })
    const environmentRpc = vi.fn()

    const outcome = await callPluginHost({
      method: 'project.add',
      params: { hostId: 'ssh:ssh-9', path: '/home/coder/api' },
      granted: ['workspace:write'],
      services: pluginHostTestServices(runtimeRpc, { environmentRpc })
    })

    expect(outcome).toEqual({
      ok: false,
      code: 'action_failed',
      error: 'this host is not connected; connect it with host.connect first'
    })
    expect(environmentRpc).not.toHaveBeenCalled()
  })

  it('adds a local folder through this computer and reports one it already had', async () => {
    const runtimeRpc = vi.fn(async (method: string) =>
      method === 'repo.list' ? { repos: [{ id: 'repo-2' }] } : { repo: { id: 'repo-2' } }
    )

    const outcome = await callPluginHost({
      method: 'project.add',
      params: { path: '/src/app', kind: 'folder' },
      granted: ['workspace:write'],
      services: pluginHostTestServices(runtimeRpc)
    })

    expect(runtimeRpc).toHaveBeenCalledWith(
      'repo.add',
      { path: '/src/app', kind: 'folder' },
      expect.objectContaining({ plugin: expect.anything() })
    )
    expect(outcome).toEqual({
      ok: true,
      value: { projectId: 'repo-2', hostId: 'local', created: false }
    })
  })
})
