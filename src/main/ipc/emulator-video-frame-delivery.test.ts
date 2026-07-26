import { describe, expect, it, vi } from 'vitest'
import {
  SCRCPY_VIDEO_MAX_GOP_FRAMES,
  SCRCPY_VIDEO_MAX_REPLAY_BYTES_PER_DEVICE,
  type ScrcpyVideoFrameMessage
} from '../emulator/scrcpy-video-registry'
import { EmulatorVideoFrameDelivery } from './emulator-video-frame-delivery'

function frame(
  pts: string,
  byteLength = 1,
  options: { config?: boolean; keyFrame?: boolean } = {}
): ScrcpyVideoFrameMessage {
  return {
    config: options.config === true,
    keyFrame: options.keyFrame === true,
    pts,
    bytes: { byteLength } as ArrayBuffer
  }
}

describe('EmulatorVideoFrameDelivery', () => {
  it('bounds a full cached replay behind one in-flight renderer message', () => {
    const send = vi.fn()
    const delivery = new EmulatorVideoFrameDelivery(send)
    const replay = [
      frame('config', 1, { config: true }),
      frame('key', 1, { keyFrame: true }),
      ...Array.from({ length: SCRCPY_VIDEO_MAX_GOP_FRAMES - 1 }, (_, index) =>
        frame(`delta-${index}`)
      )
    ]

    for (const replayed of replay) {
      delivery.enqueue(replayed)
    }
    expect(send).toHaveBeenCalledTimes(1)

    for (let deliveryId = 1; deliveryId <= replay.length; deliveryId += 1) {
      delivery.acknowledge(deliveryId)
    }
    expect(send).toHaveBeenCalledTimes(replay.length)
    expect(send.mock.calls.map(([sent]) => sent.pts)).toEqual(
      replay.map((replayed) => replayed.pts)
    )
  })

  it('waits for a keyframe after a stalled renderer overruns the frame bound', () => {
    const send = vi.fn()
    const delivery = new EmulatorVideoFrameDelivery(send)
    delivery.enqueue(frame('in-flight'))
    for (let index = 0; index < SCRCPY_VIDEO_MAX_GOP_FRAMES + 2; index += 1) {
      delivery.enqueue(frame(`dropped-${index}`))
    }

    delivery.acknowledge(1)
    delivery.enqueue(frame('still-dropped'))
    expect(send).toHaveBeenCalledTimes(1)

    delivery.enqueue(frame('config', 1, { config: true }))
    delivery.enqueue(frame('recovery-key', 1, { keyFrame: true }))
    expect(send.mock.calls[1][0].pts).toBe('config')
    delivery.acknowledge(2)
    expect(send.mock.calls[2][0].pts).toBe('recovery-key')
  })

  it('recovers from a recent queued keyframe without retaining the older GOP', () => {
    const send = vi.fn()
    const delivery = new EmulatorVideoFrameDelivery(send)
    delivery.enqueue(frame('in-flight'))
    delivery.enqueue(frame('stale-config', 1, { config: true }))
    for (let index = 0; index < 100; index += 1) {
      delivery.enqueue(frame(`old-${index}`))
    }
    delivery.enqueue(frame('new-key', 1, { keyFrame: true }))
    for (let index = 0; index < 30; index += 1) {
      delivery.enqueue(frame(`new-${index}`))
    }

    delivery.acknowledge(1)

    expect(send.mock.calls[1][0].pts).toBe('new-key')
  })

  it('drops an over-byte continuation and ignores stale acknowledgements', () => {
    const send = vi.fn()
    const delivery = new EmulatorVideoFrameDelivery(send)
    delivery.enqueue(frame('in-flight-key', 1, { keyFrame: true }))
    delivery.enqueue(frame('large-1', SCRCPY_VIDEO_MAX_REPLAY_BYTES_PER_DEVICE / 2 + 1))
    delivery.enqueue(frame('large-2', SCRCPY_VIDEO_MAX_REPLAY_BYTES_PER_DEVICE / 2 + 1))

    delivery.acknowledge(99)
    expect(send).toHaveBeenCalledTimes(1)
    delivery.acknowledge(1)
    expect(send).toHaveBeenCalledTimes(1)

    delivery.enqueue(frame('recovery-key', 1, { keyFrame: true }))
    expect(send.mock.calls[1][0].pts).toBe('recovery-key')
  })
})
