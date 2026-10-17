import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STATUS_ONLY_SIDECAR_IDLE_MS } from './computer-sidecar-status-only-idle'
import {
  callComputerSidecarCapabilities,
  callComputerSidecarPermissionStatus,
  callComputerSidecarSnapshot,
  resetComputerSidecarForTest
} from './sidecar-client'

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }))

vi.mock('child_process', () => ({ fork: forkMock }))

type SentRequest = { id: number; method: string }

class FakeChildProcess extends EventEmitter {
  killed = false
  sent: SentRequest[] = []
  send = (message: SentRequest, callback?: (error: Error | null) => void): boolean => {
    this.sent.push(message)
    callback?.(null)
    return true
  }
  kill = vi.fn(() => {
    this.killed = true
    return true
  })

  reply(index: number): void {
    this.emit('message', { id: this.sent[index]!.id, ok: true, result: {} })
  }
}

describe('computer sidecar status-only idle release', () => {
  const children: FakeChildProcess[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    children.length = 0
    forkMock.mockImplementation(() => {
      const child = new FakeChildProcess()
      children.push(child)
      return child
    })
  })

  afterEach(() => {
    resetComputerSidecarForTest()
    forkMock.mockReset()
    vi.useRealTimers()
  })

  async function answeredStatusRead(index: number): Promise<void> {
    const read = callComputerSidecarPermissionStatus(false)
    await vi.waitFor(() => expect(children[0]!.sent).toHaveLength(index + 1))
    children[0]!.reply(index)
    await read
  }

  it('stops a sidecar that only answered status reads once it is idle', async () => {
    await answeredStatusRead(0)

    await vi.advanceTimersByTimeAsync(STATUS_ONLY_SIDECAR_IDLE_MS - 1)
    expect(children[0]!.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(children[0]!.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('restarts the idle window on another status read', async () => {
    await answeredStatusRead(0)
    await vi.advanceTimersByTimeAsync(STATUS_ONLY_SIDECAR_IDLE_MS - 1_000)
    await answeredStatusRead(1)

    await vi.advanceTimersByTimeAsync(STATUS_ONLY_SIDECAR_IDLE_MS - 1)
    expect(children[0]!.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(children[0]!.kill).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['getAppState', () => callComputerSidecarSnapshot({ app: 'Finder' })],
    ['capabilities', () => callComputerSidecarCapabilities()]
  ])('keeps the sidecar for good once it serves %s', async (_method, otherCall) => {
    await answeredStatusRead(0)
    const call = otherCall()
    await vi.waitFor(() => expect(children[0]!.sent).toHaveLength(2))
    children[0]!.reply(1)
    await call
    await answeredStatusRead(2)

    await vi.advanceTimersByTimeAsync(STATUS_ONLY_SIDECAR_IDLE_MS * 3)

    expect(children[0]!.kill).not.toHaveBeenCalled()
  })

  it('never releases the sidecar under an in-flight request', async () => {
    await answeredStatusRead(0)
    await vi.advanceTimersByTimeAsync(STATUS_ONLY_SIDECAR_IDLE_MS - 1_000)
    const read = callComputerSidecarPermissionStatus(false)
    await vi.waitFor(() => expect(children[0]!.sent).toHaveLength(2))

    await vi.advanceTimersByTimeAsync(STATUS_ONLY_SIDECAR_IDLE_MS - 1_000)
    expect(children[0]!.kill).not.toHaveBeenCalled()
    children[0]!.reply(1)
    await expect(read).resolves.toEqual({})
    expect(children[0]!.kill).not.toHaveBeenCalled()
  })

  it('starts a status-only sidecar again after an idle release', async () => {
    await answeredStatusRead(0)
    await vi.advanceTimersByTimeAsync(STATUS_ONLY_SIDECAR_IDLE_MS)

    const read = callComputerSidecarPermissionStatus(false)
    await vi.waitFor(() => expect(children).toHaveLength(2))
    children[1]!.reply(0)

    await expect(read).resolves.toEqual({})
  })
})
