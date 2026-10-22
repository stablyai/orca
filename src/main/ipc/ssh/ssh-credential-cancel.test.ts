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

import type { SshCredentialKind } from '../../ssh/connection/ssh-connection-callbacks'
import type { SshTarget } from '../../../shared/ssh-types'
import { isSshCredentialDeclined } from '../../ssh/ssh-credential-decline'
import { createSshIpcHarness } from './ssh-ipc-test-harness'
import { createSshConnectionCallbacks } from './ssh-connection-state-callbacks'

const { mockSshStore, mockConnectionManager } = mocks

const target: SshTarget = {
  id: 'ssh-1',
  label: 'Server',
  host: 'example.com',
  port: 22,
  username: 'deploy'
}

describe('a cancelled SSH sign-in', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, mockWindow } = harness

  beforeEach(async () => {
    await harness.reset()
    mockSshStore.getTarget.mockReturnValue(target)
  })

  /** The prompt every connect (explicit, reconnect ladder, tunnel, census) reaches for a credential. */
  function requestCredential(
    targetId: string,
    kind: SshCredentialKind,
    detail: string,
    attempt?: AbortSignal
  ): Promise<string | null> | undefined {
    return createSshConnectionCallbacks().onCredentialRequest?.(
      targetId,
      kind,
      detail,
      undefined,
      attempt
    )
  }

  async function submitCredential(value: string | null): Promise<void> {
    const request: unknown = credentialRequests().at(-1)?.[1]
    if (!request || typeof request !== 'object' || !('requestId' in request)) {
      throw new Error('no credential prompt was shown')
    }
    await handlers.get('ssh:submitCredential')!(null, { requestId: request.requestId, value })
  }

  function credentialRequests(): unknown[] {
    return mockWindow.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'ssh:credential-request'
    )
  }

  /** What any connect does when its key or password is needed: ask, and the user cancels. */
  async function promptAndCancel(attempt?: AbortSignal): Promise<void> {
    const pending = requestCredential(target.id, 'passphrase', '~/.ssh/id_ed25519', attempt)
    await submitCredential(null)
    await expect(pending).resolves.toBeNull()
  }

  it('records nothing when the user answers the prompt', async () => {
    const pending = requestCredential(target.id, 'password', target.host)
    await submitCredential('secret')

    await expect(pending).resolves.toBe('secret')
    expect(isSshCredentialDeclined(target.id)).toBe(false)
  })

  it('is not re-prompted by a later automatic credential request for that host', async () => {
    await promptAndCancel()
    mockWindow.webContents.send.mockClear()

    // A reconnect ladder, host-resume reconnect or managed-server tunnel asking again.
    await expect(
      requestCredential(target.id, 'passphrase', '~/.ssh/id_ed25519')
    ).resolves.toBeNull()

    expect(credentialRequests()).toHaveLength(0)
  })

  it('lets the cancelled attempt still offer its other method, but not a later attempt', async () => {
    const cancelledAttempt = new AbortController().signal
    await promptAndCancel(cancelledAttempt)
    mockWindow.webContents.send.mockClear()

    // Same attempt: a password after the cancelled passphrase.
    void requestCredential(target.id, 'password', target.host, cancelledAttempt)
    expect(credentialRequests()).toHaveLength(1)

    // A later automatic attempt.
    await expect(
      requestCredential(target.id, 'password', target.host, new AbortController().signal)
    ).resolves.toBeNull()
    expect(credentialRequests()).toHaveLength(1)
  })

  it('is lifted when the host signs in anyway, e.g. through a newly loaded agent key', async () => {
    await promptAndCancel()

    createSshConnectionCallbacks().onStateChange(target.id, {
      targetId: target.id,
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    expect(isSshCredentialDeclined(target.id)).toBe(false)
  })

  it('still prompts for a different host', async () => {
    await promptAndCancel()
    mockWindow.webContents.send.mockClear()

    void requestCredential('ssh-2', 'password', 'other.example.com')

    expect(credentialRequests()).toHaveLength(1)
  })

  it('makes panes and automations that probe first treat the host as needing sign-in', async () => {
    await promptAndCancel()

    expect(await handlers.get('ssh:needsPassphrasePrompt')!(null, { targetId: target.id })).toBe(
      true
    )
  })

  it('survives an automatic connect such as startup restore', async () => {
    await promptAndCancel()

    await handlers.get('ssh:connect')!(null, { targetId: target.id, automatic: true })

    expect(isSshCredentialDeclined(target.id)).toBe(true)
  })

  it('is lifted by an explicit reconnect, which prompts again', async () => {
    await promptAndCancel()

    await handlers.get('ssh:connect')!(null, { targetId: target.id })
    mockWindow.webContents.send.mockClear()
    void requestCredential(target.id, 'password', target.host)

    expect(isSshCredentialDeclined(target.id)).toBe(false)
    expect(credentialRequests()).toHaveLength(1)
  })

  it('is lifted by an explicit connection test', async () => {
    await promptAndCancel()
    mockConnectionManager.connect.mockResolvedValue({
      getState: () => ({ targetId: target.id, status: 'connected', error: null })
    })

    await handlers.get('ssh:testConnection')!(null, { targetId: target.id })

    expect(isSshCredentialDeclined(target.id)).toBe(false)
  })
})
