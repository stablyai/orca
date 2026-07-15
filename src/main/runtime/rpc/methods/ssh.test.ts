import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SSH_METHODS } from './ssh'

const {
  addRegisteredSshTargetMock,
  browseSshDirectoryMock,
  connectRegisteredSshTargetMock,
  getSshConnectionManagerMock,
  getRegisteredSshStateMock,
  importRegisteredSshConfigMock,
  listRegisteredSshTargetsMock,
  listRegisteredRemovedSshTargetLabelsMock
} = vi.hoisted(() => ({
  addRegisteredSshTargetMock: vi.fn(),
  browseSshDirectoryMock: vi.fn(),
  connectRegisteredSshTargetMock: vi.fn(),
  getSshConnectionManagerMock: vi.fn(),
  getRegisteredSshStateMock: vi.fn(),
  importRegisteredSshConfigMock: vi.fn(),
  listRegisteredSshTargetsMock: vi.fn(),
  listRegisteredRemovedSshTargetLabelsMock: vi.fn()
}))

vi.mock('../../../ipc/ssh', () => ({
  addRegisteredSshTarget: addRegisteredSshTargetMock,
  connectRegisteredSshTarget: connectRegisteredSshTargetMock,
  getSshConnectionManager: getSshConnectionManagerMock,
  getRegisteredSshState: getRegisteredSshStateMock,
  importRegisteredSshConfig: importRegisteredSshConfigMock,
  listRegisteredSshTargets: listRegisteredSshTargetsMock,
  listRegisteredRemovedSshTargetLabels: listRegisteredRemovedSshTargetLabelsMock
}))

vi.mock('../../../ipc/ssh-browse', () => ({
  browseSshDirectory: browseSshDirectoryMock
}))

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('ssh RPC methods', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the registered SSH target state', async () => {
    const state = {
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }
    getRegisteredSshStateMock.mockReturnValueOnce(state)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.getState', { targetId: 'ssh-1' }))

    expect(getRegisteredSshStateMock).toHaveBeenCalledWith('ssh-1')
    expect(response).toMatchObject({ ok: true, result: { state } })
  })

  it('connects through the registered desktop SSH lifecycle', async () => {
    const state = {
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }
    connectRegisteredSshTargetMock.mockResolvedValueOnce(state)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.connect', { targetId: 'ssh-1' }))

    expect(connectRegisteredSshTargetMock).toHaveBeenCalledWith('ssh-1')
    expect(response).toMatchObject({ ok: true, result: { state } })
  })

  it('returns null when the target has no registered state yet', async () => {
    getRegisteredSshStateMock.mockReturnValueOnce(undefined)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.getState', { targetId: 'ssh-1' }))

    expect(response).toMatchObject({ ok: true, result: { state: null } })
  })

  it('lists the registered SSH targets for paired clients', async () => {
    const targets = [{ id: 'ssh-1', label: 'Dev box', host: 'dev', port: 22, username: 'me' }]
    listRegisteredSshTargetsMock.mockReturnValueOnce(targets)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.listTargets'))

    expect(response).toMatchObject({ ok: true, result: { targets } })
  })

  it('lists removed-target labels for ghost-host display on paired clients', async () => {
    const labels = { 'ssh-old': 'Dev box' }
    listRegisteredRemovedSshTargetLabelsMock.mockReturnValueOnce(labels)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.listRemovedTargetLabels'))

    expect(response).toMatchObject({ ok: true, result: { labels } })
  })

  it('adds a validated manual target on the runtime host', async () => {
    const target = {
      label: 'p8',
      configHost: 'p8',
      host: '192.0.2.8',
      port: 22,
      username: 'jae',
      identityFile: '~/.ssh/id_ed25519_p8'
    }
    const result = { target: { id: 'ssh-p8', ...target }, repoReadoptions: [] }
    addRegisteredSshTargetMock.mockReturnValueOnce(result)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.addTarget', { target }))

    expect(addRegisteredSshTargetMock).toHaveBeenCalledWith(target)
    expect(response).toMatchObject({ ok: true, result })
  })

  it('rejects runtime-owned target fields from paired clients', async () => {
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ssh.addTarget', {
        target: {
          label: 'hidden',
          host: 'example.com',
          port: 22,
          username: 'me',
          owner: { type: 'on-demand-runtime', runtimeId: 'spoofed' }
        }
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(addRegisteredSshTargetMock).not.toHaveBeenCalled()
  })

  it('imports the runtime host SSH config', async () => {
    const result = { targets: [], repoReadoptions: [] }
    importRegisteredSshConfigMock.mockReturnValueOnce(result)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.importConfig'))

    expect(importRegisteredSshConfigMock).toHaveBeenCalledWith({})
    expect(response).toMatchObject({ ok: true, result })
  })

  it('browses a connected target through the runtime host', async () => {
    const manager = { name: 'manager' }
    const listing = {
      resolvedPath: '/home/jae',
      entries: [{ name: 'project', isDirectory: true }]
    }
    getSshConnectionManagerMock.mockReturnValueOnce(manager)
    browseSshDirectoryMock.mockResolvedValueOnce(listing)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ssh.browseDir', { targetId: 'ssh-p8', dirPath: '~' })
    )

    expect(browseSshDirectoryMock).toHaveBeenCalledWith(manager, 'ssh-p8', '~')
    expect(response).toMatchObject({ ok: true, result: listing })
  })
})
