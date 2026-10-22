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

import type { SshTarget } from '../../../shared/ssh-types'
import { isSshCredentialDeclined } from '../../ssh/ssh-credential-decline'
import { registerSshHandlers, resetSshHandlerStateForTests } from './ssh'
import { createSshIpcHarness } from './ssh-ipc-test-harness'
import { createSshConnectionCallbacks } from './ssh-connection-state-callbacks'

const { mockSshStore, mockConnectionManager } = mocks

const passwordHost: SshTarget = {
  id: 'ssh-pw',
  label: 'Password host',
  host: 'pw.example.com',
  port: 22,
  username: 'deploy',
  lastRequiredPassphrase: true
}
const keyHost: SshTarget = {
  id: 'ssh-key',
  label: 'Key host',
  host: 'key.example.com',
  port: 22,
  username: 'deploy'
}

describe('SSH hosts that need a typed credential', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, mockStore, mockWindow } = harness

  /** A fresh app launch: the main process registers SSH with the persisted targets. */
  async function launch(targets: SshTarget[]): Promise<void> {
    await resetSshHandlerStateForTests()
    mockSshStore.listTargets.mockReturnValue(targets)
    mockSshStore.getTarget.mockImplementation((id: string) => targets.find((t) => t.id === id))
    registerAgain()
  }

  /** What the main process does at launch, and again when macOS recreates the window. */
  function registerAgain(): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the same partial store and window the shared harness registers with.
    registerSshHandlers(mockStore as never, () => mockWindow as never)
  }

  function credentialRequests(): unknown[] {
    return mockWindow.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'ssh:credential-request'
    )
  }

  function connected(targetId: string): void {
    createSshConnectionCallbacks().onStateChange(targetId, {
      targetId,
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
  }

  beforeEach(async () => {
    await harness.reset()
  })

  it('do not get a sign-in dialog from a background reconnect at launch', async () => {
    await launch([passwordHost, keyHost])

    // Startup restore, managed-server status checks and tunnels all ask through this callback.
    await expect(
      createSshConnectionCallbacks().onCredentialRequest?.(
        passwordHost.id,
        'password',
        passwordHost.host,
        undefined,
        new AbortController().signal
      )
    ).resolves.toBeNull()

    expect(credentialRequests()).toHaveLength(0)
    expect(isSshCredentialDeclined(passwordHost.id)).toBe(true)
    expect(isSshCredentialDeclined(keyHost.id)).toBe(false)
    expect(
      await handlers.get('ssh:needsPassphrasePrompt')!(null, { targetId: passwordHost.id })
    ).toBe(true)
  })

  it('stay waiting through an automatic connect, and prompt once the user connects', async () => {
    await launch([passwordHost])

    await handlers.get('ssh:connect')!(null, { targetId: passwordHost.id, automatic: true })
    expect(isSshCredentialDeclined(passwordHost.id)).toBe(true)

    await handlers.get('ssh:connect')!(null, { targetId: passwordHost.id })
    expect(isSshCredentialDeclined(passwordHost.id)).toBe(false)
    void createSshConnectionCallbacks().onCredentialRequest?.(
      passwordHost.id,
      'password',
      passwordHost.host,
      undefined,
      new AbortController().signal
    )
    expect(credentialRequests()).toHaveLength(1)
  })

  it('are not re-gated when the window re-registers SSH after the user signed in', async () => {
    await launch([passwordHost])
    await handlers.get('ssh:connect')!(null, { targetId: passwordHost.id })

    registerAgain()

    expect(isSshCredentialDeclined(passwordHost.id)).toBe(false)
  })

  it('are remembered as needing one after a sign-in that asked', async () => {
    const fresh = { ...keyHost, id: 'ssh-new', lastRequiredPassphrase: undefined }
    await launch([fresh])

    void createSshConnectionCallbacks().onCredentialRequest?.(
      fresh.id,
      'password',
      fresh.host,
      undefined,
      new AbortController().signal
    )
    connected(fresh.id)

    expect(mockSshStore.updateTarget).toHaveBeenCalledWith(fresh.id, {
      lastRequiredPassphrase: true
    })
  })

  it('are remembered as needing one when a kept password signed in without asking', async () => {
    const fresh = { ...keyHost, id: 'ssh-new', lastRequiredPassphrase: false }
    await launch([fresh])
    mockConnectionManager.getConnection.mockReturnValue({ hasCachedCredential: () => true })

    connected(fresh.id)

    expect(mockSshStore.updateTarget).toHaveBeenCalledWith(fresh.id, {
      lastRequiredPassphrase: true
    })
  })

  it('are cleared once the host signs in without any typed credential', async () => {
    await launch([passwordHost])
    mockConnectionManager.getConnection.mockReturnValue({ hasCachedCredential: () => false })

    connected(passwordHost.id)

    expect(mockSshStore.updateTarget).toHaveBeenCalledWith(passwordHost.id, {
      lastRequiredPassphrase: false
    })
  })
})
