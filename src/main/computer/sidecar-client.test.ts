import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callComputerSidecarCapabilities, resetComputerSidecarForTest } from './sidecar-client'

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

  send(message: SentRequest, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    callback?.(null)
    return true
  }

  kill(): boolean {
    this.killed = true
    return true
  }
}

describe('computer sidecar client', () => {
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

  it('ignores stale child exit and error after a replacement sidecar starts', async () => {
    const firstCall = callComputerSidecarCapabilities()
    const firstRejection = expect(firstCall).rejects.toThrow(
      'computer sidecar capabilities timed out'
    )
    const firstChild = children[0]!

    await vi.advanceTimersByTimeAsync(60_000)
    await firstRejection
    expect(firstChild.killed).toBe(true)

    const secondCall = callComputerSidecarCapabilities()
    const secondChild = children[1]!
    const secondRequest = secondChild.sent[0]!

    // Why: OS process events from a timed-out child can arrive after restart.
    // They must not clear/reject the replacement child's active request.
    firstChild.emit('error', new Error('old sidecar failed late'))
    firstChild.emit('exit', 1, null)

    secondChild.emit('message', {
      id: secondRequest.id,
      ok: true,
      result: { supports: { screenshots: true } }
    })

    await expect(secondCall).resolves.toEqual({ supports: { screenshots: true } })
  })
})
