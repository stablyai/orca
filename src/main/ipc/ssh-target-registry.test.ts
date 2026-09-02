import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../ssh/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('./ssh-pty-output-intake-registry', () => mocks.sshPtyOutputIntakeRegistry)
vi.mock('../ssh/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('../ssh/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../ssh/ssh-relay-deploy', () => mocks.sshRelayDeploy)
vi.mock('../ssh/ssh-relay-reset', () => mocks.sshRelayReset)
vi.mock('../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../providers/ssh-pty-provider', () => mocks.sshPtyProvider)
vi.mock('../providers/ssh-filesystem-provider', () => mocks.sshFilesystemProvider)
vi.mock('./pty', () => mocks.pty)
vi.mock('../providers/ssh-filesystem-dispatch', () => mocks.sshFilesystemDispatch)
vi.mock('../providers/ssh-git-provider', () => mocks.sshGitProvider)
vi.mock('../providers/ssh-git-dispatch', () => mocks.sshGitDispatch)
vi.mock('../ssh/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)

import type { SshTarget } from '../../shared/ssh-types'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const {
  mockSshStore,
  mockConnectionManager,
  mockMux,
  mockPortForwardManager,
  mockListConfigHosts,
  mockResolveConfigHost
} = mocks

describe('SSH IPC handlers', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, mockStore, mockWindow } = harness

  beforeEach(harness.reset)

  it('registers all expected IPC channels', () => {
    const channels = Array.from(handlers.keys())
    expect(channels).toContain('ssh:listTargets')
    expect(channels).toContain('ssh:addTarget')
    expect(channels).toContain('ssh:updateTarget')
    expect(channels).toContain('ssh:removeTarget')
    expect(channels).toContain('ssh:importConfig')
    expect(channels).toContain('ssh:listConfigHosts')
    expect(channels).toContain('ssh:resolveConfigHost')
    expect(channels).toContain('ssh:connect')
    expect(channels).toContain('ssh:disconnect')
    expect(channels).toContain('ssh:terminateSessions')
    expect(channels).toContain('ssh:resetRelay')
    expect(channels).toContain('ssh:getState')
    expect(channels).toContain('ssh:testConnection')
  })

  it('ssh:listTargets returns targets from store', async () => {
    const mockTargets: SshTarget[] = [
      { id: 'ssh-1', label: 'Server 1', host: 'srv1.com', port: 22, username: 'admin' }
    ]
    mockSshStore.listTargets.mockReturnValue(mockTargets)

    const result = await handlers.get('ssh:listTargets')!(null, {})
    expect(result).toEqual(mockTargets)
  })

  it('ssh:addTarget calls store.addTarget', async () => {
    const newTarget = {
      label: 'New Server',
      host: 'new.example.com',
      port: 22,
      username: 'deploy'
    }
    const withId = { ...newTarget, id: 'ssh-new' }
    mockSshStore.addTarget.mockReturnValue(withId)

    const result = await handlers.get('ssh:addTarget')!(null, { target: newTarget })
    expect(mockSshStore.addTarget).toHaveBeenCalledWith(newTarget)
    expect(result).toEqual({ target: withId, repoReadoptions: [] })
  })

  it('ssh:addTarget strips a renderer-supplied registration generation', async () => {
    const target = {
      label: 'New Server',
      host: 'new.example.com',
      port: 22,
      username: 'deploy',
      generation: 999
    }
    mockSshStore.addTarget.mockReturnValue({ ...target, id: 'ssh-new', generation: 7 })

    await handlers.get('ssh:addTarget')!(null, { target })

    expect(mockSshStore.addTarget).toHaveBeenCalledWith({
      label: 'New Server',
      host: 'new.example.com',
      port: 22,
      username: 'deploy'
    })
  })

  it('ssh:updateTarget strips a renderer-supplied registration generation', async () => {
    await handlers.get('ssh:updateTarget')!(null, {
      id: 'ssh-1',
      updates: { label: 'Renamed', generation: 999 }
    })

    expect(mockSshStore.updateTarget).toHaveBeenCalledWith('ssh-1', { label: 'Renamed' })
  })

  it('ssh:addTarget returns exact re-adoption evidence and refreshes repos', async () => {
    const target = {
      id: 'ssh-new',
      label: 'Server',
      host: 'server.example.com',
      port: 22,
      username: 'deploy'
    }
    const repoReadoptions = [
      { oldTargetId: 'ssh-old', newTargetId: 'ssh-new', repoIds: ['repo-1'] }
    ]
    mockSshStore.addTarget.mockReturnValue(target)
    mockSshStore.lastRepoReadoptions = repoReadoptions

    const result = await handlers.get('ssh:addTarget')!(null, { target })

    expect(result).toEqual({ target, repoReadoptions })
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('repos:changed')
    expect(mockSshStore.lastRepoReadoptions).toEqual([])
  })

  it('ssh:removeTarget calls store.removeTarget', async () => {
    await handlers.get('ssh:removeTarget')!(null, { id: 'ssh-1' })
    expect(mockSshStore.removeTarget).toHaveBeenCalledWith('ssh-1')
  })

  it('ssh:removeTarget removes metadata when disconnect fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mockConnectionManager.disconnect.mockRejectedValueOnce(new Error('host unreachable'))
    try {
      await handlers.get('ssh:removeTarget')!(null, { id: 'ssh-1' })

      expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1')
      expect(mockStore.removeSshRemotePtyLeases).toHaveBeenCalledWith('ssh-1')
      expect(mockSshStore.removeTarget).toHaveBeenCalledWith('ssh-1')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('ssh:removeTarget tears down an active relay before deleting the target', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    mockPortForwardManager.removeAllForwards.mockClear()
    mockConnectionManager.disconnect.mockClear().mockResolvedValue(undefined)

    await handlers.get('ssh:removeTarget')!(null, { id: 'ssh-1' })

    expect(mockPortForwardManager.removeAllForwards).toHaveBeenCalledWith('ssh-1')
    expect(mockMux.dispose).toHaveBeenCalledWith('shutdown')
    expect(mockStore.markSshRemotePtyLeasesAsync).toHaveBeenCalledWith('ssh-1', 'terminated')
    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1')
    expect(mockStore.removeSshRemotePtyLeases).toHaveBeenCalledWith('ssh-1')
    expect(mockSshStore.removeTarget).toHaveBeenCalledWith('ssh-1')
  })

  it('ssh:importConfig returns imported targets', async () => {
    const imported: SshTarget[] = [
      { id: 'ssh-imp', label: 'staging', host: 'staging.com', port: 22, username: '' }
    ]
    mockSshStore.importFromSshConfig.mockReturnValue(imported)

    const result = await handlers.get('ssh:importConfig')!(null, {})
    expect(result).toEqual({ targets: imported, repoReadoptions: [] })
  })

  it('ssh:listConfigHosts loads summaries against current targets', async () => {
    mockSshStore.listTargets.mockReturnValue([
      { id: 'ssh-1', label: 'other', host: 'other.com', port: 22, username: 'x' }
    ])

    const result = await handlers.get('ssh:listConfigHosts')!(null, { query: 'oth' })

    expect(mockSshStore.listTargets).toHaveBeenCalled()
    expect(mockListConfigHosts).toHaveBeenCalledWith(mockSshStore.listTargets(), 'oth', [], {
      refresh: false
    })
    expect(result).toMatchObject({ hosts: [], hasMore: false })
  })

  // Only a picker (re)open re-reads ~/.ssh/config; filter keystrokes reuse the parse.
  it('ssh:listConfigHosts refreshes the parsed config only when asked', async () => {
    mockSshStore.listTargets.mockReturnValue([])

    await handlers.get('ssh:listConfigHosts')!(null, { query: '', refresh: true })

    expect(mockListConfigHosts).toHaveBeenCalledWith([], '', [], { refresh: true })
  })

  it('ssh:resolveConfigHost resolves only the selected alias', async () => {
    await handlers.get('ssh:resolveConfigHost')!(null, { alias: 'prod' })

    expect(mockResolveConfigHost).toHaveBeenCalledWith('prod')
  })

  it('ssh:getState returns connection state', async () => {
    const state = {
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }
    mockConnectionManager.getState.mockReturnValue(state)

    const result = await handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' })
    expect(result).toEqual({
      ...state,
      providerEpoch: expect.any(String),
      connectionGeneration: 0
    })
  })
})
