import { ipcMain, type BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerCredentialHandler, requestCredential } from './ssh-passphrase'
import { resetSshCredentialDeclinesForTests } from '../../ssh/ssh-credential-decline'

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
