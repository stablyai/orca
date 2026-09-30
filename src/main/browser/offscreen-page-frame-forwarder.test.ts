import { describe, expect, it, vi } from 'vitest'
import { createOffscreenPageFrameForwarder } from './offscreen-page-frame-forwarder'

type TestFrame = { id: number; release: ReturnType<typeof vi.fn<() => void>> }

function frame(id: number): TestFrame {
  return { id, release: vi.fn<() => void>() }
}

function deferredTransport() {
  const deliveries: { frame: TestFrame; resolve: () => void; reject: (e: unknown) => void }[] = []
  return {
    deliveries,
    transport: {
      deliver: (f: TestFrame) =>
        new Promise<void>((resolve, reject) => deliveries.push({ frame: f, resolve, reject }))
    }
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createOffscreenPageFrameForwarder', () => {
  it('delivers the first frame immediately', () => {
    const { deliveries, transport } = deferredTransport()
    const forwarder = createOffscreenPageFrameForwarder(transport)

    forwarder.onPaint(frame(1))

    expect(deliveries.map((d) => d.frame.id)).toEqual([1])
  })

  it('parks only the newest frame while one is in flight and delivers it afterwards', async () => {
    const { deliveries, transport } = deferredTransport()
    const forwarder = createOffscreenPageFrameForwarder(transport)
    const second = frame(2)
    const third = frame(3)

    forwarder.onPaint(frame(1))
    forwarder.onPaint(second)
    forwarder.onPaint(third)
    expect(second.release).toHaveBeenCalledTimes(1)

    deliveries[0].resolve()
    await settle()

    expect(deliveries.map((d) => d.frame.id)).toEqual([1, 3])
    expect(third.release).not.toHaveBeenCalled()
  })

  it('keeps forwarding after a failed delivery', async () => {
    const { deliveries, transport } = deferredTransport()
    const onError = vi.fn()
    const forwarder = createOffscreenPageFrameForwarder(transport, onError)

    forwarder.onPaint(frame(1))
    forwarder.onPaint(frame(2))
    deliveries[0].reject(new Error('renderer gone'))
    await settle()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(deliveries.map((d) => d.frame.id)).toEqual([1, 2])
  })

  it('releases parked and later frames once disposed', async () => {
    const { deliveries, transport } = deferredTransport()
    const forwarder = createOffscreenPageFrameForwarder(transport)
    const parked = frame(2)
    const late = frame(3)

    forwarder.onPaint(frame(1))
    forwarder.onPaint(parked)
    forwarder.dispose()
    forwarder.onPaint(late)
    deliveries[0].resolve()
    await settle()

    expect(parked.release).toHaveBeenCalledTimes(1)
    expect(late.release).toHaveBeenCalledTimes(1)
    expect(deliveries).toHaveLength(1)
  })
})
