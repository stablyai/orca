import { describe, expect, it, vi } from 'vitest'
import { bindPluginHostServices, translatePluginWorkspaceRef } from './plugin-host-service-bindings'
import { PLUGIN_HOST_FILE_API_SPECS } from '../../shared/plugins/plugin-host-file-api'

function createDelegate() {
  return {
    listPluginWorkspaces: vi.fn(),
    resolveActiveWorktreeContext: vi.fn(),
    listTerminals: vi.fn(),
    sendTerminal: vi.fn(),
    dispatchPluginNotification: vi.fn(),
    executePluginFileMethod: vi.fn()
  }
}

describe('plugin workspace service binding', () => {
  it('returns the runtime projection unchanged from one delegate call', async () => {
    const delegate = createDelegate()
    const catalog = { workspaces: [{ ref: 'id:folder-1', hostId: 'local', displayName: 'One' }] }
    delegate.listPluginWorkspaces.mockResolvedValue(catalog)
    const services = bindPluginHostServices({
      delegate,
      pluginsDataDir: '/plugins',
      subscribeEvents: vi.fn()
    })

    await expect(services.listPluginWorkspaces()).resolves.toBe(catalog)
    expect(delegate.listPluginWorkspaces).toHaveBeenCalledTimes(1)
  })
})

describe('translatePluginWorkspaceRef', () => {
  it('keeps plugin workspace references path-free', () => {
    expect(
      translatePluginWorkspaceRef({ type: 'worktree', identity: 'wt2:host:instance' })
    ).toEqual({
      scope: 'worktree-identity',
      identity: 'wt2:host:instance'
    })
    expect(translatePluginWorkspaceRef({ type: 'folder', id: 'folder-1' })).toEqual({
      scope: 'folder-workspace',
      folderWorkspaceId: 'folder-1'
    })
  })
})

describe('plugin file service binding', () => {
  it.each([
    ['files.read' as const, 'identity:wt2%3Alocal%3Ainstance', 'identity:wt2:local:instance'],
    ['files.stat' as const, 'identity:wt2%3Alocal%3Ainstance', 'identity:wt2:local:instance'],
    ['files.readDir' as const, 'identity:wt2%3Alocal%3Ainstance', 'identity:wt2:local:instance'],
    ['files.read' as const, 'id:folder%20id%2Fone', 'id:folder id/one'],
    ['files.stat' as const, 'id:folder%20id%2Fone', 'id:folder id/one'],
    ['files.readDir' as const, 'id:folder%20id%2Fone', 'id:folder id/one']
  ])('resolves the exact listed ref through %s', async (method, listedRef, selector) => {
    const delegate = createDelegate()
    delegate.executePluginFileMethod.mockResolvedValue({ authorized: true, value: {} })
    const services = bindPluginHostServices({
      delegate,
      pluginsDataDir: '/plugins',
      subscribeEvents: vi.fn()
    })
    const spec = PLUGIN_HOST_FILE_API_SPECS.find(({ name }) => name === method)!
    const params = spec.params.parse({ workspaceRef: listedRef, relativePath: 'docs/readme.md' })
    const grant = { kind: 'files:read' as const, paths: ['docs/**'] }

    await services.executeAuthorizedPluginHostCall(method, params, grant)

    expect(delegate.executePluginFileMethod).toHaveBeenCalledWith(
      method,
      selector,
      'docs/readme.md',
      grant
    )
  })

  it('rejects malformed percent encoding before authority lookup', () => {
    const spec = PLUGIN_HOST_FILE_API_SPECS.find(({ name }) => name === 'files.read')!

    expect(() =>
      spec.params.parse({ workspaceRef: 'identity:broken%2', relativePath: 'docs/readme.md' })
    ).toThrow('invalid workspace reference encoding')
  })

  it.each([
    ['files.read' as const, { type: 'worktree' as const, identity: 'opaque' }, 'identity:opaque'],
    ['files.stat' as const, { type: 'folder' as const, id: 'folder-1' }, 'id:folder-1'],
    ['files.readDir' as const, { type: 'folder' as const, id: 'folder-2' }, 'id:folder-2']
  ])('delegates %s as one authorized host operation', async (method, workspaceRef, selector) => {
    const delegate = createDelegate()
    const expected = { authorized: true as const, value: { marker: method } }
    delegate.executePluginFileMethod.mockResolvedValue(expected)
    const services = bindPluginHostServices({
      delegate,
      pluginsDataDir: '/plugins',
      subscribeEvents: vi.fn()
    })
    const grant = { kind: 'files:read' as const, paths: ['docs/**'] }

    await expect(
      services.executeAuthorizedPluginHostCall(
        method,
        { workspaceRef, relativePath: 'docs/readme.md' },
        grant
      )
    ).resolves.toEqual(expected)
    expect(delegate.executePluginFileMethod).toHaveBeenCalledWith(
      method,
      selector,
      'docs/readme.md',
      grant
    )
  })

  it('fails closed without a parsed file request and matching grant', async () => {
    const delegate = createDelegate()
    const services = bindPluginHostServices({
      delegate,
      pluginsDataDir: '/plugins',
      subscribeEvents: vi.fn()
    })

    await expect(
      services.executeAuthorizedPluginHostCall('files.read', {}, { kind: 'storage' })
    ).resolves.toEqual({ authorized: false })
    expect(delegate.executePluginFileMethod).not.toHaveBeenCalled()
  })
})
