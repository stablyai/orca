import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      ipc.handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => ipc.handlers.delete(channel))
  }
}))

import { orcaWindowManager } from '../window/orca-window-manager'
import { registerCredentialHandler, requestCredential } from './ssh-passphrase'

class TestWebContents extends EventEmitter {
  readonly id: number
  readonly mainFrame = {}
  readonly send = vi.fn()
  destroyed = false

  constructor(id: number) {
    super()
    this.id = id
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  getType(): 'window' {
    return 'window'
  }

  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

function createWindow(id: number) {
  const webContents = new TestWebContents(id + 100)
  return {
    id,
    webContents,
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    }
  }
}

function requestIdFrom(window: ReturnType<typeof createWindow>): string {
  return window.webContents.send.mock.calls.find(
    ([channel]) => channel === 'ssh:credential-request'
  )?.[1].requestId as string
}

function submit(
  window: ReturnType<typeof createWindow>,
  requestId: string,
  value: string | null,
  senderFrame: object | null = window.webContents.mainFrame
): unknown {
  return ipc.handlers.get('ssh:submitCredential')!(
    { sender: window.webContents, senderFrame },
    { requestId, value }
  )
}

describe('SSH credential prompt ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    registerCredentialHandler()
    for (const window of orcaWindowManager.getAllWindows()) {
      orcaWindowManager.remove(window.id)
    }
  })

  afterEach(async () => {
    await vi.runAllTimersAsync()
    vi.useRealTimers()
  })

  it('pins the prompt and resolution to the most recently focused Orca window', async () => {
    const first = createWindow(1)
    const recent = createWindow(2)
    orcaWindowManager.register(first as never, 'control')
    orcaWindowManager.register(recent as never, 'secondary')
    orcaWindowManager.noteFocused(recent.id)

    const result = requestCredential(() => first as never, 'target-1', 'password', 'deploy')
    const requestId = requestIdFrom(recent)
    expect(requestId).toBeTypeOf('string')
    orcaWindowManager.noteFocused(first.id)
    submit(recent, requestId, 'secret')

    await expect(result).resolves.toBe('secret')
    expect(first.webContents.send).not.toHaveBeenCalled()
    expect(recent.webContents.send).toHaveBeenCalledWith('ssh:credential-resolved', {
      requestId
    })
  })

  it('rejects another window and an obsolete or subframe sender', async () => {
    const owner = createWindow(1)
    const other = createWindow(2)
    orcaWindowManager.register(owner as never, 'control')
    orcaWindowManager.register(other as never, 'secondary')
    orcaWindowManager.noteFocused(owner.id)
    const result = requestCredential(() => other as never, 'target-1', 'passphrase', '/key')
    const requestId = requestIdFrom(owner)
    expect(requestId).toBeTypeOf('string')

    submit(other, requestId, 'other-window')
    submit(owner, requestId, 'subframe', {})
    expect(owner.webContents.send).not.toHaveBeenCalledWith(
      'ssh:credential-resolved',
      expect.anything()
    )

    submit(owner, requestId, 'owner')
    await expect(result).resolves.toBe('owner')
  })

  it('resolves immediately and removes the exact listener when the owner is destroyed', async () => {
    const owner = createWindow(1)
    const other = createWindow(2)
    orcaWindowManager.register(owner as never, 'control')
    orcaWindowManager.register(other as never, 'secondary')
    orcaWindowManager.noteFocused(owner.id)
    const result = requestCredential(() => other as never, 'target-1', 'password', 'deploy')

    expect(owner.webContents.listenerCount('destroyed')).toBe(1)
    owner.webContents.destroy()

    await expect(Promise.race([result, Promise.resolve('pending')])).resolves.toBeNull()
    expect(owner.webContents.listenerCount('destroyed')).toBe(0)
    expect(other.webContents.send).not.toHaveBeenCalled()
  })

  it('keeps a live owner request submit-able across handler re-registration', async () => {
    const owner = createWindow(1)
    const promoted = createWindow(2)
    orcaWindowManager.register(owner as never, 'control')
    orcaWindowManager.register(promoted as never, 'secondary')
    orcaWindowManager.noteFocused(owner.id)
    const result = requestCredential(() => owner as never, 'target-1', 'password', 'deploy')
    const requestId = requestIdFrom(owner)

    orcaWindowManager.noteFocused(promoted.id)
    registerCredentialHandler()
    submit(owner, requestId, 'secret')

    await expect(result).resolves.toBe('secret')
    expect(owner.webContents.send).toHaveBeenCalledWith('ssh:credential-resolved', { requestId })
    expect(promoted.webContents.send).not.toHaveBeenCalled()
    expect(owner.webContents.listenerCount('destroyed')).toBe(0)
  })

  it('keeps timeout resolution pinned to the original owner', async () => {
    const owner = createWindow(1)
    const recent = createWindow(2)
    orcaWindowManager.register(owner as never, 'control')
    orcaWindowManager.register(recent as never, 'secondary')
    orcaWindowManager.noteFocused(owner.id)
    const result = requestCredential(() => recent as never, 'target-1', 'password', 'deploy')
    const requestId = requestIdFrom(owner)
    orcaWindowManager.noteFocused(recent.id)

    await vi.advanceTimersByTimeAsync(120_000)

    await expect(result).resolves.toBeNull()
    expect(owner.webContents.send).toHaveBeenCalledWith('ssh:credential-resolved', { requestId })
    expect(recent.webContents.send).not.toHaveBeenCalled()
  })

  it('returns null without creating a request when no renderer is available', async () => {
    await expect(
      requestCredential(() => null, 'target-1', 'password', 'deploy')
    ).resolves.toBeNull()
  })

  it('still settles when the owned renderer rejects the resolved notification', async () => {
    const owner = createWindow(1)
    orcaWindowManager.register(owner as never, 'control')
    const result = requestCredential(() => owner as never, 'target-1', 'password', 'deploy')
    const requestId = requestIdFrom(owner)
    owner.webContents.send.mockImplementationOnce(() => {
      throw new Error('frame unavailable')
    })

    expect(() => submit(owner, requestId, 'secret')).not.toThrow()
    await expect(result).resolves.toBe('secret')
    expect(owner.webContents.listenerCount('destroyed')).toBe(0)
  })
})
