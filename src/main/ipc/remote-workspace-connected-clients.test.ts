import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getActiveMultiplexerMock, getSshConnectionStoreMock } = vi.hoisted(() => ({
  getActiveMultiplexerMock: vi.fn(),
  getSshConnectionStoreMock: vi.fn()
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: getActiveMultiplexerMock,
  getSshConnectionStore: getSshConnectionStoreMock
}))

import { listRemoteWorkspaceConnectedClients } from './remote-workspace-connected-clients'
import { CLIENT_ID } from './remote-workspace-client-identity'

const TARGET = { id: 'ssh-1', label: 'build box' }

describe('listRemoteWorkspaceConnectedClients', () => {
  const request = vi.fn(async () => ({ clients: [] }))

  beforeEach(() => {
    request.mockClear()
    getSshConnectionStoreMock.mockReturnValue({ listTargets: () => [TARGET] })
    getActiveMultiplexerMock.mockImplementation((id: string) =>
      id === TARGET.id ? { request } : undefined
    )
  })

  it('introduces this desktop by the name the runtime publishes, and follows a rename', async () => {
    let machineName = 'Build server'
    const runtime = { readMachineName: () => machineName }

    await listRemoteWorkspaceConnectedClients(undefined, runtime)
    expect(request).toHaveBeenCalledWith(
      'workspace.presence',
      expect.objectContaining({ clientId: CLIENT_ID, clientName: 'Build server' })
    )

    // Why: the name is read per presence frame, so a rename in Settings reaches the host without a relaunch.
    machineName = 'Renamed desk'
    await listRemoteWorkspaceConnectedClients(undefined, runtime)
    expect(request).toHaveBeenLastCalledWith(
      'workspace.presence',
      expect.objectContaining({ clientId: CLIENT_ID, clientName: 'Renamed desk' })
    )
  })
})
