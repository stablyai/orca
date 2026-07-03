import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS,
  CLIPBOARD_TEXT_WRITE_MAX_BYTES,
  CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR
} from '../../shared/clipboard-text'
import {
  callComputerSidecarAction,
  callComputerSidecarCapabilities,
  resetComputerSidecarForTest
} from './sidecar-client'

const { forkMock } = vi.hoisted(() => ({
  forkMock: vi.fn()
}))

vi.mock('child_process', () => ({
  fork: forkMock
}))

type SentRequest = {
  id: number
  method: string
  params: unknown
}

class FakeChildProcess extends EventEmitter {
  killed = false
  sent: SentRequest[] = []
  deferSendCallback = false
  sendCallbacks: ((error: Error | null) => void)[] = []

  send: ((message: SentRequest, callback?: (error: Error | null) => void) => boolean) | undefined =
    (message, callback) => {
      this.sent.push(message)
      if (callback && this.deferSendCallback) {
        this.sendCallbacks.push(callback)
      } else {
        callback?.(null)
      }
      return true
    }

  kill(): boolean {
    this.killed = true
    return true
  }

  flushSendCallback(error: Error | null): void {
    this.sendCallbacks.shift()?.(error)
  }
}

describe('computer sidecar client', () => {
  const children: FakeChildProcess[] = []
  let deferNextSendCallback = false

  beforeEach(() => {
    vi.useFakeTimers()
    children.length = 0
    deferNextSendCallback = false
    forkMock.mockImplementation(() => {
      const child = new FakeChildProcess()
      child.deferSendCallback = deferNextSendCallback
      deferNextSendCallback = false
      children.push(child)
      return child
    })
  })

  afterEach(() => {
    resetComputerSidecarForTest()
    forkMock.mockReset()
    vi.useRealTimers()
  })

  it('ignores stale child exit and error after a replacement sidecar starts', async () => {
    const firstCall = callComputerSidecarCapabilities()
    const firstRejection = expect(firstCall).rejects.toThrow(
      'computer sidecar capabilities timed out'
    )
    const firstChild = children[0]!

    await vi.advanceTimersByTimeAsync(60_000)
    await firstRejection
    expect(firstChild.killed).toBe(true)
    expect(firstChild.listenerCount('message')).toBe(0)
    expect(firstChild.listenerCount('exit')).toBe(0)
    expect(firstChild.listenerCount('error')).toBe(1)

    const secondCall = callComputerSidecarCapabilities()
    const secondChild = children[1]!
    const secondRequest = secondChild.sent[0]!

    // Why: OS process events from a timed-out child can arrive after restart.
    // They must not clear/reject the replacement child's active request.
    firstChild.emit('message', {
      id: secondRequest.id,
      ok: false,
      error: { code: 'old', message: 'old sidecar replied late' }
    })
    expect(() => firstChild.emit('error', new Error('old sidecar failed late'))).not.toThrow()
    firstChild.emit('exit', 1, null)

    secondChild.emit('message', {
      id: secondRequest.id,
      ok: true,
      result: { supports: { screenshots: true } }
    })

    await expect(secondCall).resolves.toEqual({ supports: { screenshots: true } })
  })

  it('starts a replacement sidecar after the active child errors', async () => {
    const firstCall = callComputerSidecarCapabilities()
    const firstRejection = expect(firstCall).rejects.toThrow('active sidecar failed')
    const firstChild = children[0]!

    firstChild.emit('error', new Error('active sidecar failed'))
    await firstRejection
    expect(firstChild.killed).toBe(true)
    expect(firstChild.listenerCount('message')).toBe(0)
    expect(firstChild.listenerCount('exit')).toBe(0)
    expect(firstChild.listenerCount('error')).toBe(1)

    const secondCall = callComputerSidecarCapabilities()
    void secondCall.catch(() => undefined)
    expect(children).toHaveLength(2)
    const secondChild = children[1]!
    const secondRequest = secondChild.sent[0]!

    secondChild.emit('message', {
      id: secondRequest.id,
      ok: true,
      result: { supports: { screenshots: true } }
    })

    await expect(secondCall).resolves.toEqual({ supports: { screenshots: true } })
  })

  it('serializes requests so desktop actions cannot overlap', async () => {
    const firstCall = callComputerSidecarCapabilities()
    const secondCall = callComputerSidecarCapabilities()
    const child = children[0]!

    expect(child.sent).toHaveLength(1)
    const firstRequest = child.sent[0]!

    child.emit('message', {
      id: firstRequest.id,
      ok: true,
      result: { provider: 'first' }
    })

    await expect(firstCall).resolves.toEqual({ provider: 'first' })
    await vi.waitFor(() => expect(child.sent).toHaveLength(2))
    const secondRequest = child.sent[1]!

    child.emit('message', {
      id: secondRequest.id,
      ok: true,
      result: { provider: 'second' }
    })

    await expect(secondCall).resolves.toEqual({ provider: 'second' })
  })

  it('marks synthetic action results without provider verification as unverified', async () => {
    const call = callComputerSidecarAction('click', { app: 'Finder', elementIndex: 0 })
    const child = children[0]!
    const request = child.sent[0]!

    child.emit('message', {
      id: request.id,
      ok: true,
      result: {
        snapshot: {
          id: 'snap-1',
          app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
          window: { title: 'Finder', id: 1, width: 800, height: 600 },
          coordinateSpace: 'window',
          treeText: 'tree',
          elementCount: 1,
          focusedElementId: null
        },
        screenshot: null,
        screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
        action: {
          path: 'synthetic',
          actionName: null,
          fallbackReason: null,
          targetWindowId: 1
        }
      }
    })

    await expect(call).resolves.toMatchObject({
      action: {
        path: 'synthetic',
        verification: { state: 'unverified', reason: 'synthetic_input' }
      }
    })
  })

  it('marks clipboard action results without provider verification as unverified', async () => {
    const call = callComputerSidecarAction('pasteText', { app: 'Finder', text: 'draft' })
    const child = children[0]!
    const request = child.sent[0]!

    child.emit('message', {
      id: request.id,
      ok: true,
      result: {
        snapshot: {
          id: 'snap-1',
          app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
          window: { title: 'Finder', id: 1, width: 800, height: 600 },
          coordinateSpace: 'window',
          treeText: 'tree',
          elementCount: 1,
          focusedElementId: null
        },
        screenshot: null,
        screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
        action: {
          path: 'clipboard',
          actionName: 'paste',
          fallbackReason: null,
          targetWindowId: 1
        }
      }
    })

    await expect(call).resolves.toMatchObject({
      action: {
        path: 'clipboard',
        verification: { state: 'unverified', reason: 'clipboard_paste' }
      }
    })
  })

  it('rejects oversized pasteText payloads before forking the sidecar', async () => {
    const secret = 'sidecar-secret-token'

    await expect(
      callComputerSidecarAction('pasteText', {
        app: 'Finder',
        text: secret + 'x'.repeat(CLIPBOARD_TEXT_WRITE_MAX_BYTES + 1)
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR
    })

    expect(children).toHaveLength(0)
  })

  it('yields while validating large accepted pasteText payloads before forking', async () => {
    const text = 'é'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)

    const call = callComputerSidecarAction('pasteText', { app: 'Finder', text })
    await Promise.resolve()

    expect(children).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(0)
    expect(children).toHaveLength(1)
    const child = children[0]!
    const request = child.sent[0]!
    child.emit('message', {
      id: request.id,
      ok: true,
      result: { action: { path: 'clipboard', actionName: 'paste' } }
    })

    await expect(call).resolves.toMatchObject({
      action: { path: 'clipboard' }
    })
  })

  it('rejects queued requests after the active request times out', async () => {
    const firstCall = callComputerSidecarCapabilities()
    const secondCall = callComputerSidecarCapabilities()
    const firstRejection = expect(firstCall).rejects.toThrow(
      'computer sidecar capabilities timed out'
    )
    const secondRejection = expect(secondCall).rejects.toThrow(
      'computer sidecar queue was invalidated'
    )
    const child = children[0]!

    expect(child.sent).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60_000)

    await firstRejection
    await secondRejection
    expect(children).toHaveLength(1)
  })

  it('rejects queued requests after the active child errors', async () => {
    const firstCall = callComputerSidecarCapabilities()
    const secondCall = callComputerSidecarCapabilities()
    const firstRejection = expect(firstCall).rejects.toThrow('active sidecar failed')
    const secondRejection = expect(secondCall).rejects.toThrow(
      'computer sidecar queue was invalidated'
    )
    const child = children[0]!

    child.emit('error', new Error('active sidecar failed'))

    await firstRejection
    await secondRejection
    expect(children).toHaveLength(1)
  })

  it('invalidates queued requests after IPC send fails', async () => {
    deferNextSendCallback = true
    const firstCall = callComputerSidecarCapabilities()
    const secondCall = callComputerSidecarCapabilities()
    const firstChild = children[0]!
    const firstRejection = expect(firstCall).rejects.toThrow('ipc channel closed')
    const secondRejection = expect(secondCall).rejects.toThrow(
      'computer sidecar queue was invalidated'
    )

    firstChild.flushSendCallback(new Error('ipc channel closed'))

    await firstRejection
    await secondRejection
    expect(firstChild.killed).toBe(true)
    expect(firstChild.listenerCount('message')).toBe(0)
    expect(firstChild.listenerCount('exit')).toBe(0)
    expect(firstChild.listenerCount('error')).toBe(1)

    const thirdCall = callComputerSidecarCapabilities()
    const secondChild = children[1]!
    const thirdRequest = secondChild.sent[0]!
    secondChild.emit('message', {
      id: thirdRequest.id,
      ok: true,
      result: { supports: { screenshots: true } }
    })

    await expect(thirdCall).resolves.toEqual({ supports: { screenshots: true } })
  })

  it('fails immediately when the forked sidecar has no IPC send channel', async () => {
    forkMock.mockImplementationOnce(() => {
      const child = new FakeChildProcess()
      child.send = undefined
      children.push(child)
      return child
    })

    const call = callComputerSidecarCapabilities()

    await expect(call).rejects.toThrow('computer sidecar IPC is unavailable')
    expect(children[0]!.killed).toBe(true)
    expect(children[0]!.listenerCount('message')).toBe(0)
    expect(children[0]!.listenerCount('exit')).toBe(0)
    expect(children[0]!.listenerCount('error')).toBe(1)
  })
})
