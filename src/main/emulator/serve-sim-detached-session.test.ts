import { describe, expect, it } from 'vitest'
import { parseServeSimDetachedSession } from './serve-sim-detached-session'

describe('parseServeSimDetachedSession', () => {
  it('uses serve-sim streamUrl when present', () => {
    const info = parseServeSimDetachedSession(
      {
        device: 'device-1',
        streamUrl: 'http://127.0.0.1:3100/stream.mjpeg',
        wsUrl: 'ws://127.0.0.1:3100/ws'
      },
      'device-1'
    )

    expect(info).toMatchObject({
      deviceUdid: 'device-1',
      streamUrl: 'http://127.0.0.1:3100/stream.mjpeg',
      wsUrl: 'ws://127.0.0.1:3100/ws'
    })
  })

  it('derives the MJPEG stream endpoint from older serve-sim url output', () => {
    const info = parseServeSimDetachedSession(
      {
        device: 'device-2',
        url: 'http://127.0.0.1:3100',
        wsUrl: 'ws://127.0.0.1:3100/ws'
      },
      'device-2'
    )

    expect(info.streamUrl).toBe('http://127.0.0.1:3100/stream.mjpeg')
  })
})
