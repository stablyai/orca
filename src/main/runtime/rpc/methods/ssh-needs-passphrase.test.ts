import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../../../shared/remote-runtime/ssh/ssh-types'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SSH_METHODS } from './ssh/ssh'

const { listRegisteredSshTargetsMock, getSshConnectionManagerMock, isSshCredentialDeclinedMock } =
  vi.hoisted(() => ({
    listRegisteredSshTargetsMock: vi.fn(),
    getSshConnectionManagerMock: vi.fn(),
    isSshCredentialDeclinedMock: vi.fn()
  }))

vi.mock('../../../ssh/targets/ssh-target-registry', () => ({
  connectRegisteredSshTarget: vi.fn(),
  getRegisteredSshState: vi.fn(),
  listRegisteredSshTargets: listRegisteredSshTargetsMock,
  listRegisteredRemovedSshTargetLabels: vi.fn(),
  getSshConnectionManager: getSshConnectionManagerMock,
  markSshTestProbe: vi.fn(),
  unmarkSshTestProbe: vi.fn()
}))

vi.mock('../../../ssh/ssh-credential-decline', () => ({
  isSshCredentialDeclined: isSshCredentialDeclinedMock
}))

function makeTarget(overrides?: Partial<SshTarget>): SshTarget {
  return {
    id: 'ssh-1',
    label: 'ssh-1',
    host: 'example.invalid',
    port: 22,
    username: 'orca',
    ...overrides
  }
}

function dispatchNeedsPrompt(targetId: string): Promise<unknown> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test-only stub; the exercised handlers never read runtime fields.
  const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })
  return dispatcher.dispatch({
    id: 'req-1',
    authToken: 'tok',
    method: 'ssh.needsPassphrasePrompt',
    params: { targetId }
  } satisfies RpcRequest)
}

describe('ssh.needsPassphrasePrompt', () => {
  it('reprompts when the credential was declined', async () => {
    isSshCredentialDeclinedMock.mockReturnValueOnce(true)
    const response = await dispatchNeedsPrompt('ssh-1')
    expect(response).toMatchObject({ ok: true, result: { needsPrompt: true } })
    expect(listRegisteredSshTargetsMock).not.toHaveBeenCalled()
  })

  it('skips the prompt for unknown targets', async () => {
    isSshCredentialDeclinedMock.mockReturnValueOnce(false)
    listRegisteredSshTargetsMock.mockReturnValueOnce([])
    const response = await dispatchNeedsPrompt('missing')
    expect(response).toMatchObject({ ok: true, result: { needsPrompt: false } })
  })

  it('skips the prompt when the last connect needed no passphrase', async () => {
    isSshCredentialDeclinedMock.mockReturnValueOnce(false)
    listRegisteredSshTargetsMock.mockReturnValueOnce([makeTarget()])
    const response = await dispatchNeedsPrompt('ssh-1')
    expect(response).toMatchObject({ ok: true, result: { needsPrompt: false } })
  })

  it('skips the prompt when a live connection already caches the credential', async () => {
    isSshCredentialDeclinedMock.mockReturnValueOnce(false)
    listRegisteredSshTargetsMock.mockReturnValueOnce([makeTarget({ lastRequiredPassphrase: true })])
    getSshConnectionManagerMock.mockReturnValueOnce({ hasCachedCredential: () => true })
    const response = await dispatchNeedsPrompt('ssh-1')
    expect(response).toMatchObject({ ok: true, result: { needsPrompt: false } })
  })

  it('prompts when the passphrase is uncached', async () => {
    isSshCredentialDeclinedMock.mockReturnValueOnce(false)
    listRegisteredSshTargetsMock.mockReturnValueOnce([makeTarget({ lastRequiredPassphrase: true })])
    getSshConnectionManagerMock.mockReturnValueOnce({ hasCachedCredential: () => false })
    const response = await dispatchNeedsPrompt('ssh-1')
    expect(response).toMatchObject({ ok: true, result: { needsPrompt: true } })
  })

  it('prompts when no connection manager is registered', async () => {
    isSshCredentialDeclinedMock.mockReturnValueOnce(false)
    listRegisteredSshTargetsMock.mockReturnValueOnce([makeTarget({ lastRequiredPassphrase: true })])
    getSshConnectionManagerMock.mockReturnValueOnce(null)
    const response = await dispatchNeedsPrompt('ssh-1')
    expect(response).toMatchObject({ ok: true, result: { needsPrompt: true } })
  })
})
