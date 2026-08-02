import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SSH_METHODS } from './ssh'

const {
  connectRegisteredSshTargetMock,
  getRegisteredSshStateMock,
  listRegisteredSshTargetsMock,
  listRegisteredRemovedSshTargetLabelsMock
} = vi.hoisted(() => ({
  connectRegisteredSshTargetMock: vi.fn(),
  getRegisteredSshStateMock: vi.fn(),
  listRegisteredSshTargetsMock: vi.fn(),
  listRegisteredRemovedSshTargetLabelsMock: vi.fn()
}))

vi.mock('../../../ipc/ssh', () => ({
  connectRegisteredSshTarget: connectRegisteredSshTargetMock,
  getRegisteredSshState: getRegisteredSshStateMock,
  listRegisteredSshTargets: listRegisteredSshTargetsMock,
  listRegisteredRemovedSshTargetLabels: listRegisteredRemovedSshTargetLabelsMock
}))

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('ssh RPC methods', () => {
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

  it('redacts HUB-private diagnostics from state and connect failures', async () => {
    const privateMessage = 'identity /Users/hub/.ssh/private via bastion.internal failed'
    getRegisteredSshStateMock.mockReturnValue({
      targetId: 'ssh-1',
      status: 'auth-failed',
      error: privateMessage,
      reconnectAttempt: 0
    })
    connectRegisteredSshTargetMock.mockRejectedValueOnce(new Error(privateMessage))
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const stateResponse = await dispatcher.dispatch(
      makeRequest('ssh.getState', { targetId: 'ssh-1' })
    )
    const connectResponse = await dispatcher.dispatch(
      makeRequest('ssh.connect', { targetId: 'ssh-1' })
    )

    expect(stateResponse).toMatchObject({
      ok: true,
      result: { state: { error: 'SSH authentication failed' } }
    })
    expect(connectResponse).toMatchObject({
      ok: false,
      error: { message: 'SSH authentication failed' }
    })
    expect(JSON.stringify([stateResponse, connectResponse])).not.toContain(privateMessage)
  })

  it('lists redacted SSH target summaries for paired clients', async () => {
    const targets = [
      {
        id: 'ssh-1',
        label: 'Dev box',
        host: 'dev.internal',
        port: 22,
        username: 'me',
        identityFile: '/secret/key',
        jumpHost: 'bastion',
        proxyCommand: 'private proxy'
      }
    ]
    listRegisteredSshTargetsMock.mockReturnValueOnce(targets)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.listTargetSummaries'))

    expect(response).toMatchObject({
      ok: true,
      result: { targets: [{ id: 'ssh-1', label: 'Dev box' }] }
    })
    expect(JSON.stringify(response)).not.toContain('dev.internal')
    expect(JSON.stringify(response)).not.toContain('/secret/key')
    expect(JSON.stringify(response)).not.toContain('bastion')
  })

  it('redacts the legacy target response for older clients', async () => {
    const targets = [
      {
        id: 'ssh-1',
        label: 'Dev box',
        host: 'dev.internal',
        port: 22,
        username: 'me',
        identityFile: '/secret/key',
        jumpHost: 'bastion'
      }
    ]
    listRegisteredSshTargetsMock.mockReturnValueOnce(targets)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.listTargets'))

    expect(response).toMatchObject({
      ok: true,
      result: { targets: [{ id: 'ssh-1', label: 'Dev box' }] }
    })
    expect(JSON.stringify(response)).not.toContain('dev.internal')
    expect(JSON.stringify(response)).not.toContain('/secret/key')
    expect(JSON.stringify(response)).not.toContain('bastion')
  })

  it('lists removed-target labels for ghost-host display on paired clients', async () => {
    const labels = { 'ssh-old': 'Dev box' }
    listRegisteredRemovedSshTargetLabelsMock.mockReturnValueOnce(labels)
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.listRemovedTargetLabels'))

    expect(response).toMatchObject({ ok: true, result: { labels } })
  })
})
