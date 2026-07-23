import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getUtf8ByteLength } from '../../shared/utf8-byte-limits'
import {
  SSH_CREDENTIAL_DETAIL_MAX_UTF8_BYTES,
  SSH_RETAINED_IDENTIFIER_MAX_UTF8_BYTES
} from '../../shared/ssh-retained-payload-admission'

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
  return {
    handlers,
    ipcMain: {
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
      handle: vi.fn((channel: string, handler: (event: unknown, args: unknown) => unknown) => {
        handlers.set(channel, handler)
      })
    }
  }
})

vi.mock('electron', () => ({ ipcMain: electronMocks.ipcMain }))

import {
  getPendingCredentialRequestCountForTests,
  registerCredentialHandler,
  requestCredential,
  resetPendingCredentialRequestsForTests,
  SSH_CREDENTIAL_VALUE_MAX_UTF8_BYTES,
  SSH_MAX_PENDING_CREDENTIAL_REQUESTS
} from './ssh-passphrase'

function createWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() }
  }
}

describe('SSH credential request admission', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    electronMocks.handlers.clear()
    resetPendingCredentialRequestsForTests()
  })

  afterEach(() => {
    resetPendingCredentialRequestsForTests()
    vi.useRealTimers()
  })

  it('forwards ordinary metadata and resolves the submitted credential', async () => {
    const win = createWindow()
    registerCredentialHandler(() => win as never)
    const result = requestCredential(() => win as never, 'ssh-a', 'password', 'example.test')
    const request = win.webContents.send.mock.calls[0][1] as { requestId: string }

    electronMocks.handlers.get('ssh:submitCredential')?.(
      {},
      {
        requestId: request.requestId,
        value: 'secret'
      }
    )

    await expect(result).resolves.toBe('secret')
    expect(win.webContents.send).toHaveBeenNthCalledWith(1, 'ssh:credential-request', {
      requestId: request.requestId,
      targetId: 'ssh-a',
      kind: 'password',
      detail: 'example.test'
    })
    expect(win.webContents.send).toHaveBeenNthCalledWith(2, 'ssh:credential-resolved', {
      requestId: request.requestId
    })
  })

  it('caps detail before sending it to the renderer', () => {
    const win = createWindow()

    void requestCredential(
      () => win as never,
      'ssh-a',
      'passphrase',
      '🙂'.repeat(SSH_CREDENTIAL_DETAIL_MAX_UTF8_BYTES)
    )

    const sent = win.webContents.send.mock.calls[0][1] as { detail: string }
    expect(getUtf8ByteLength(sent.detail)).toBeLessThanOrEqual(SSH_CREDENTIAL_DETAIL_MAX_UTF8_BYTES)
  })

  it('rejects an oversized submitted credential without retaining the request', async () => {
    const win = createWindow()
    registerCredentialHandler(() => win as never)
    const result = requestCredential(() => win as never, 'ssh-a', 'password', 'example.test')
    const request = win.webContents.send.mock.calls[0][1] as { requestId: string }

    electronMocks.handlers.get('ssh:submitCredential')?.(
      {},
      {
        requestId: request.requestId,
        value: '🙂'.repeat(SSH_CREDENTIAL_VALUE_MAX_UTF8_BYTES)
      }
    )

    await expect(result).resolves.toBeNull()
    expect(getPendingCredentialRequestCountForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles a submitted credential when its resolution notification throws', async () => {
    const win = createWindow()
    registerCredentialHandler(() => win as never)
    const result = requestCredential(() => win as never, 'ssh-a', 'password', 'example.test')
    const request = win.webContents.send.mock.calls[0][1] as { requestId: string }
    win.webContents.send.mockImplementation(() => {
      throw new Error('renderer gone')
    })

    electronMocks.handlers.get('ssh:submitCredential')?.(
      {},
      {
        requestId: request.requestId,
        value: 'secret'
      }
    )

    await expect(result).resolves.toBe('secret')
    expect(getPendingCredentialRequestCountForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles a timed-out credential when its resolution notification throws', async () => {
    const win = createWindow()
    const result = requestCredential(() => win as never, 'ssh-a', 'password', 'example.test')
    win.webContents.send.mockImplementation(() => {
      throw new Error('renderer gone')
    })

    await vi.runAllTimersAsync()

    await expect(result).resolves.toBeNull()
    expect(getPendingCredentialRequestCountForTests()).toBe(0)
  })

  it('rejects an oversized target without allocating request state', async () => {
    const win = createWindow()
    const result = requestCredential(
      () => win as never,
      'x'.repeat(SSH_RETAINED_IDENTIFIER_MAX_UTF8_BYTES + 1),
      'password',
      'host'
    )

    await expect(result).resolves.toBeNull()
    expect(getPendingCredentialRequestCountForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('fails closed at the pending-request cap without adding a timer or map row', async () => {
    const win = createWindow()
    const pending = Array.from({ length: SSH_MAX_PENDING_CREDENTIAL_REQUESTS }, (_, index) =>
      requestCredential(() => win as never, `ssh-${index}`, 'password', 'host')
    )
    expect(getPendingCredentialRequestCountForTests()).toBe(SSH_MAX_PENDING_CREDENTIAL_REQUESTS)
    expect(vi.getTimerCount()).toBe(SSH_MAX_PENDING_CREDENTIAL_REQUESTS)

    const overflow = requestCredential(() => win as never, 'ssh-overflow', 'password', 'host')

    await expect(overflow).resolves.toBeNull()
    expect(getPendingCredentialRequestCountForTests()).toBe(SSH_MAX_PENDING_CREDENTIAL_REQUESTS)
    expect(vi.getTimerCount()).toBe(SSH_MAX_PENDING_CREDENTIAL_REQUESTS)
    expect(win.webContents.send).toHaveBeenCalledTimes(SSH_MAX_PENDING_CREDENTIAL_REQUESTS)
    resetPendingCredentialRequestsForTests()
    await expect(Promise.all(pending)).resolves.toEqual(
      Array.from({ length: SSH_MAX_PENDING_CREDENTIAL_REQUESTS }, () => null)
    )
  })
})
