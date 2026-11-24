import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SSH_METHODS } from './ssh/ssh'

const {
  connectRegisteredSshTargetMock,
  getRegisteredSshStateMock,
  listRegisteredSshTargetsMock,
  listRegisteredRemovedSshTargetLabelsMock,
  getSshConnectionManagerMock,
  markSshTestProbeMock,
  unmarkSshTestProbeMock,
  isSshCredentialDeclinedMock,
  legacyRelayBridgedPanesMock,
  attachLegacyRelayPaneMock,
  detachLegacyRelayPaneMock,
  closeLegacyRelayPaneMock,
  writeLegacyRelayPaneMock,
  resizeLegacyRelayPaneMock,
  setLegacyRelayPaneOutputPausedMock
} = vi.hoisted(() => ({
  connectRegisteredSshTargetMock: vi.fn(),
  getRegisteredSshStateMock: vi.fn(),
  listRegisteredSshTargetsMock: vi.fn(),
  listRegisteredRemovedSshTargetLabelsMock: vi.fn(),
  getSshConnectionManagerMock: vi.fn(),
  markSshTestProbeMock: vi.fn(),
  unmarkSshTestProbeMock: vi.fn(),
  isSshCredentialDeclinedMock: vi.fn(),
  legacyRelayBridgedPanesMock: vi.fn(),
  attachLegacyRelayPaneMock: vi.fn(),
  detachLegacyRelayPaneMock: vi.fn(),
  closeLegacyRelayPaneMock: vi.fn(),
  writeLegacyRelayPaneMock: vi.fn(),
  resizeLegacyRelayPaneMock: vi.fn(),
  setLegacyRelayPaneOutputPausedMock: vi.fn()
}))

vi.mock('../../../ssh/targets/ssh-target-registry', () => ({
  connectRegisteredSshTarget: connectRegisteredSshTargetMock,
  getRegisteredSshState: getRegisteredSshStateMock,
  listRegisteredSshTargets: listRegisteredSshTargetsMock,
  listRegisteredRemovedSshTargetLabels: listRegisteredRemovedSshTargetLabelsMock,
  getSshConnectionManager: getSshConnectionManagerMock,
  markSshTestProbe: markSshTestProbeMock,
  unmarkSshTestProbe: unmarkSshTestProbeMock
}))

vi.mock('../../../ssh/ssh-credential-decline', () => ({
  isSshCredentialDeclined: isSshCredentialDeclinedMock
}))

vi.mock('../../../ssh/legacy-relay/bridge/legacy-relay-bridge-registry', () => ({
  installLegacyRelayBridge: vi.fn(),
  terminalsBucket: vi.fn(),
  startLegacyRelayBridge: vi.fn(),
  stopLegacyRelayBridge: vi.fn(),
  forgetLegacyRelayTarget: vi.fn(),
  legacyRelayBridgedPanes: legacyRelayBridgedPanesMock,
  attachLegacyRelayPane: attachLegacyRelayPaneMock,
  writeLegacyRelayPane: writeLegacyRelayPaneMock,
  resizeLegacyRelayPane: resizeLegacyRelayPaneMock,
  setLegacyRelayPaneOutputPaused: setLegacyRelayPaneOutputPausedMock,
  isLegacyRelayBridgedPty: vi.fn(),
  closeLegacyRelayPane: closeLegacyRelayPaneMock,
  detachLegacyRelayPane: detachLegacyRelayPaneMock
}))

function dispatch(method: string, params?: unknown): Promise<unknown> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test-only stub; the exercised handlers never read runtime fields.
  const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })
  return dispatcher.dispatch({
    id: 'req-1',
    authToken: 'tok',
    method,
    params
  } satisfies RpcRequest)
}

describe('ssh legacy relay bridge RPC methods', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists bridged panes from the registry', async () => {
    const panes = [{ ptyId: 'ssh:t@@r1', targetId: 't', tabId: 'tab', state: 'live' }]
    legacyRelayBridgedPanesMock.mockReturnValueOnce(panes)
    const response = await dispatch('ssh.listLegacyRelayBridgedPanes')
    expect(response).toMatchObject({ ok: true, result: { panes } })
  })

  it('attaches through the registry and returns its verdict', async () => {
    attachLegacyRelayPaneMock.mockResolvedValueOnce({ status: 'not-bridged' })
    const response = await dispatch('ssh.attachLegacyRelayBridgedPane', { ptyId: 'ssh:t@@r1' })
    expect(attachLegacyRelayPaneMock).toHaveBeenCalledWith('ssh:t@@r1')
    expect(response).toMatchObject({ ok: true, result: { status: 'not-bridged' } })
  })

  it('rejects an empty pty id instead of reaching the registry', async () => {
    const response = await dispatch('ssh.attachLegacyRelayBridgedPane', { ptyId: '' })
    expect(response).toMatchObject({ ok: false })
    expect(attachLegacyRelayPaneMock).not.toHaveBeenCalled()
  })

  it('writes, resizes, pauses and detaches through the registry', async () => {
    const write = await dispatch('ssh.writeLegacyRelayBridgedPane', {
      ptyId: 'ssh:t@@r1',
      data: 'ls\n'
    })
    expect(writeLegacyRelayPaneMock).toHaveBeenCalledWith('ssh:t@@r1', 'ls\n')
    expect(write).toMatchObject({ ok: true, result: { written: true } })
    const resize = await dispatch('ssh.resizeLegacyRelayBridgedPane', {
      ptyId: 'ssh:t@@r1',
      cols: 80,
      rows: 24
    })
    expect(resizeLegacyRelayPaneMock).toHaveBeenCalledWith('ssh:t@@r1', 80, 24)
    expect(resize).toMatchObject({ ok: true, result: { resized: true } })
    const paused = await dispatch('ssh.setLegacyRelayBridgedPaneOutputPaused', {
      ptyId: 'ssh:t@@r1',
      paused: true
    })
    expect(setLegacyRelayPaneOutputPausedMock).toHaveBeenCalledWith('ssh:t@@r1', true)
    expect(paused).toMatchObject({ ok: true, result: { paused: true } })
    const detached = await dispatch('ssh.detachLegacyRelayBridgedPane', {
      ptyId: 'ssh:t@@r1',
      acquisitionId: 7
    })
    expect(detachLegacyRelayPaneMock).toHaveBeenCalledWith('ssh:t@@r1', 7)
    expect(detached).toMatchObject({ ok: true, result: { detached: true } })
  })

  it('closes through the registry and returns its verdict', async () => {
    closeLegacyRelayPaneMock.mockResolvedValueOnce({ status: 'requested' })
    const response = await dispatch('ssh.closeLegacyRelayBridgedPane', { ptyId: 'ssh:t@@r1' })
    expect(closeLegacyRelayPaneMock).toHaveBeenCalledWith('ssh:t@@r1')
    expect(response).toMatchObject({ ok: true, result: { status: 'requested' } })
  })
})
