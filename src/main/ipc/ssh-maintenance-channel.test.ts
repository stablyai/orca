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
vi.mock('../ssh/ssh-connection', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...mocks.sshConnection
}))
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

import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../shared/constants'
import type { SshTarget } from '../../shared/ssh-types'
import { quitTeardownStartGate } from '../quit-teardown-start-gate'
import { credentialRequestedForTarget } from './ssh-connect-attempt-registry'
import { createSshIpcHarness } from './ssh-ipc-test-harness'
import { sshMaintenanceOperations } from './ssh-maintenance-channel'
import { beginSshShutdown } from './ssh-shutdown-drain'

const {
  mockSshStore,
  mockConnectionManager,
  mockMaintenanceConnection,
  mockDeployAndLaunchRelay,
  mockMux
} = mocks

const TARGET: SshTarget = {
  id: 'ssh-1',
  label: 'Dev box',
  host: 'example.com',
  port: 22,
  username: 'deploy'
}

type CredentialRequest = { requestId: string; targetId: string; kind: string }

function maintenanceCallbacks(): {
  onCredentialRequest: (targetId: string, kind: string, detail: string) => Promise<string | null>
} {
  const callbacks = mockMaintenanceConnection.callbacksRef.current
  if (
    !callbacks ||
    typeof callbacks !== 'object' ||
    !('onCredentialRequest' in callbacks) ||
    typeof callbacks.onCredentialRequest !== 'function'
  ) {
    throw new Error('The maintenance connection has no credential prompter')
  }
  const prompt = callbacks.onCredentialRequest
  return {
    onCredentialRequest: async (targetId, kind, detail) => {
      const answer: unknown = await prompt(targetId, kind, detail)
      return typeof answer === 'string' ? answer : null
    }
  }
}

describe('SSH maintenance channel', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, mockWindow, mockStore } = harness

  const terminate = (): Promise<unknown> =>
    Promise.resolve(handlers.get('ssh:terminateSessions')!(null, { targetId: TARGET.id }))

  const sent = (channel: string): unknown[] =>
    mockWindow.webContents.send.mock.calls
      .filter(([sentChannel]) => sentChannel === channel)
      .map(([, payload]) => payload)

  // A passphrase-protected key: the real connection asks, and treats no answer as a refusal.
  const usePassphraseProtectedKey = (): void => {
    const open = mockMaintenanceConnection.connect.getMockImplementation()!
    mockMaintenanceConnection.connect.mockImplementation(async () => {
      const passphrase = await maintenanceCallbacks().onCredentialRequest(
        TARGET.id,
        'passphrase',
        '~/.ssh/id_ed25519'
      )
      if (passphrase === null) {
        throw new Error('Passphrase required for encrypted key')
      }
      await open()
    })
  }

  const pendingCredentialRequest = async (): Promise<CredentialRequest> => {
    await vi.waitFor(() => expect(sent('ssh:credential-request')).toHaveLength(1))
    const [request] = sent('ssh:credential-request')
    expect(request).toMatchObject({ targetId: TARGET.id, kind: 'passphrase' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: toMatchObject above proved the shape.
    return request as CredentialRequest
  }

  beforeEach(async () => {
    await harness.reset()
    mockSshStore.getTarget.mockReturnValue(TARGET)
    // A lease only the relay can end, with no live session to end it.
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: TARGET.id, ptyId: 'pty-1', state: 'detached' }
    ])
  })

  it('asks for a passphrase through the usual prompt and carries on with the answer', async () => {
    usePassphraseProtectedKey()
    const operation = terminate()

    const request = await pendingCredentialRequest()
    await handlers.get('ssh:submitCredential')!(null, {
      requestId: request.requestId,
      value: 'secret'
    })

    await expect(operation).resolves.toEqual({ terminated: 1, unverifiable: 0 })
    expect(sent('ssh:credential-resolved')).toEqual([{ requestId: request.requestId }])
    expect(sent('ssh:state-changed')).toEqual([])
    // Why: only the user's own connect may record that this host prompts at startup.
    expect(credentialRequestedForTarget.has(TARGET.id)).toBe(false)
    expect(mockSshStore.updateTarget).not.toHaveBeenCalled()
    expect(mockConnectionManager.connect).not.toHaveBeenCalled()
  })

  it('ends cleanly when the user cancels the passphrase prompt', async () => {
    usePassphraseProtectedKey()
    const operation = terminate()

    const request = await pendingCredentialRequest()
    await handlers.get('ssh:submitCredential')!(null, { requestId: request.requestId, value: null })

    await expect(operation).rejects.toThrow(SSH_TERMINATE_RECONNECT_REQUIRED)
    expect(mockMaintenanceConnection.disconnect).toHaveBeenCalled()
    expect(mockDeployAndLaunchRelay).not.toHaveBeenCalled()
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalled()
    expect(sshMaintenanceOperations.size).toBe(0)
  })

  it('closes the connection when the relay deploy throws', async () => {
    mockDeployAndLaunchRelay.mockRejectedValueOnce(new Error('upload failed'))

    await expect(terminate()).rejects.toThrow(SSH_TERMINATE_RECONNECT_REQUIRED)

    expect(mockMaintenanceConnection.disconnect).toHaveBeenCalled()
    expect(mockMux.request).not.toHaveBeenCalled()
    expect(sshMaintenanceOperations.size).toBe(0)
  })

  it('is joined and aborted by the shutdown drain, leaving no connection behind', async () => {
    // A handshake that only ends when the connection is closed.
    const close = mockMaintenanceConnection.disconnect.getMockImplementation()!
    const handshake = Promise.withResolvers<void>()
    mockMaintenanceConnection.connect.mockReturnValue(handshake.promise)
    mockMaintenanceConnection.disconnect.mockImplementation(async () => {
      handshake.reject(new Error('Connection disposed'))
      await close()
    })
    const operation = terminate()
    await vi.waitFor(() => expect(sshMaintenanceOperations.size).toBe(1))

    quitTeardownStartGate.tryStart({ preventDefault() {} })
    const drained = await beginSshShutdown()

    expect(drained.unfinished).toEqual([])
    expect(mockMaintenanceConnection.disconnect).toHaveBeenCalled()
    await expect(operation).rejects.toThrow('Connection disposed')
    expect(sshMaintenanceOperations.size).toBe(0)

    // And after the fence, a new operation opens nothing at all.
    mockMaintenanceConnection.constructed.mockClear()
    await expect(terminate()).rejects.toThrow('closed for app shutdown')
    expect(mockMaintenanceConnection.constructed).not.toHaveBeenCalled()
  })
})
