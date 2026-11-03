import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../../ssh/config/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('../../ssh/connection/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('./ssh-host-server-connect', () => mocks.hostServerConnect)
vi.mock('../../ssh/connection/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../../ssh/port-forwarding/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)

import { createSshIpcHarness } from './ssh-ipc-test-harness'

const { mockSshStore, mockConnectionManager, mockListConfigHosts } = mocks

describe('SSH IPC handlers', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, mockStore, mockWindow } = harness

  beforeEach(harness.reset)

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

  it("ssh:listConfigHosts flags the latest route snapshot's duplicates without waiting, and refreshes it when asked", async () => {
    mockSshStore.currentSshRouteSnapshot.mockReturnValue({
      duplicateOf: new Map([['aimp', 'AI Box']])
    })

    await handlers.get('ssh:listConfigHosts')!(null, { query: 'a' })
    expect(mockSshStore.refreshSshRouteSnapshot).not.toHaveBeenCalled()
    await handlers.get('ssh:listConfigHosts')!(null, { query: '', refresh: true })

    expect(mockListConfigHosts.mock.lastCall?.[3].routeDuplicateAliases).toEqual(new Set(['aimp']))
    expect(mockSshStore.refreshSshRouteSnapshot).toHaveBeenCalledOnce()
  })
})
