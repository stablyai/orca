import { ipcMain, type BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCredentialHandler, requestCredential } from './ssh-passphrase'
import { SSH_CREDENTIAL_TIMEOUT_MS } from '../../ssh/connection/ssh-connection-timing'
import {
  isSshCredentialDeclined,
  resetSshCredentialDeclinesForTests
} from '../../ssh/ssh-credential-decline'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
}))

function credentialWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

describe('SSH credential requests', () => {
  beforeEach(() => {
    resetSshCredentialDeclinesForTests()
  })

  it('records an unanswered prompt as a decline', async () => {
    vi.useFakeTimers()
    try {
      const pending = requestCredential(() => credentialWindow(), 'target-1', 'passphrase', 'key')
      await vi.advanceTimersByTimeAsync(SSH_CREDENTIAL_TIMEOUT_MS)
      await expect(pending).resolves.toBeNull()
      expect(isSshCredentialDeclined('target-1')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not record a decline for an aborted or windowless request', async () => {
    const controller = new AbortController()
    const aborted = requestCredential(
      () => credentialWindow(),
      'target-1',
      'password',
      'host',
      undefined,
      controller.signal
    )
    controller.abort()
    await aborted

    await requestCredential(() => null, 'target-1', 'password', 'host')

    expect(isSshCredentialDeclined('target-1')).toBe(false)
  })

  it('resolves and removes the renderer prompt when its connection aborts', async () => {
    const window = credentialWindow()
    const controller = new AbortController()
    const pending = requestCredential(
      () => window,
      'target-1',
      'keyboard-interactive',
      'Duo response',
      undefined,
      controller.signal
    )
    const request = vi.mocked(window.webContents.send).mock.calls[0][1] as { requestId: string }

    controller.abort()

    await expect(pending).resolves.toBeNull()
    expect(window.webContents.send).toHaveBeenLastCalledWith('ssh:credential-resolved', {
      requestId: request.requestId
    })
  })

  it('closes every other open prompt for the host the user cancelled', async () => {
    registerCredentialHandler()
    const handler = vi.mocked(ipcMain.handle).mock.calls.at(-1)![1]
    const submit = (requestId: string, value: string | null): unknown =>
      handler(Object.create(null), { requestId, value })
    const window = credentialWindow()
    const requestIds = (): string[] =>
      vi
        .mocked(window.webContents.send)
        .mock.calls.flatMap(([channel, request]) =>
          channel === 'ssh:credential-request' &&
          request &&
          typeof request === 'object' &&
          'requestId' in request &&
          typeof request.requestId === 'string'
            ? [request.requestId]
            : []
        )
    const first = requestCredential(
      () => window,
      'target-1',
      'password',
      'host',
      undefined,
      new AbortController().signal
    )
    const queued = requestCredential(
      () => window,
      'target-1',
      'password',
      'host',
      undefined,
      new AbortController().signal
    )
    const otherHost = requestCredential(() => window, 'target-2', 'password', 'other')
    const [firstId, queuedId, otherId] = requestIds()

    await submit(firstId, null)

    await expect(first).resolves.toBeNull()
    await expect(queued).resolves.toBeNull()
    expect(window.webContents.send).toHaveBeenCalledWith('ssh:credential-resolved', {
      requestId: queuedId
    })
    await submit(otherId, 'secret')
    await expect(otherHost).resolves.toBe('secret')
  })
})
