import type * as NodeFs from 'node:fs'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  callComputerSidecarAction,
  callComputerSidecarCapabilities,
  resetComputerSidecarForTest
} from './sidecar-client'

type TestAppEnvironment = { getAppPath(): string; isPackaged(): boolean }

const { forkMock, existsSyncMock, appEnvironment } = vi.hoisted(() => {
  const environment: { current: TestAppEnvironment | null } = { current: null }
  return {
    forkMock: vi.fn(),
    existsSyncMock: vi.fn((_path: string) => true),
    appEnvironment: environment
  }
})

vi.mock('child_process', () => ({
  fork: forkMock
}))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  existsSync: existsSyncMock
}))

vi.mock('../../../shared/app-environment', () => ({
  hasAppEnvironment: () => appEnvironment.current !== null,
  getAppEnvironment: () => appEnvironment.current
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
    existsSyncMock.mockImplementation(() => true)
    appEnvironment.current = null
    vi.useRealTimers()
  })

  it('fails set-value when the provider read the write back as a different value', async () => {
    const call = callComputerSidecarAction('setValue', {
      app: 'Safari',
      elementIndex: 15,
      value: 'pf1300-awllch'
    })
    const child = children[0]!
    const request = child.sent[0]!

    child.emit('message', {
      id: request.id,
      ok: true,
      result: {
        snapshot: {
          id: 'snap-1',
          app: { name: 'Safari', bundleId: 'com.apple.Safari', pid: 100 },
          window: { title: 'Form', id: 63, width: 800, height: 600 },
          coordinateSpace: 'window',
          treeText: 'tree',
          elementCount: 16,
          focusedElementId: null
        },
        screenshot: null,
        screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
        action: {
          path: 'accessibility',
          actionName: 'AXSetValue',
          fallbackReason: null,
          targetWindowId: 63,
          verification: {
            state: 'unverified',
            reason: 'value_mismatch',
            expected: 'pf1300-awllch',
            actualPreview: 'orig-objective-1300'
          }
        }
      }
    })

    await expect(call).rejects.toMatchObject({
      code: 'verification_failed',
      message: expect.stringContaining('"orig-objective-1300"')
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
})
