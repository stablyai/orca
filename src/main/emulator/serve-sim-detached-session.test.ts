import { describe, expect, it } from 'vitest'
import {
  deriveAxUrlFromStreamUrl,
  parseServeSimDetachedSession
} from './serve-sim-detached-session'

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
      wsUrl: 'ws://127.0.0.1:3100/ws',
      axUrl: 'http://127.0.0.1:3100/ax'
    })
  })

  it('derives the device-scoped AX endpoint and preserves an explicit one', () => {
    const derived = parseServeSimDetachedSession(
      {
        streamUrl: 'http://127.0.0.1:3200/helper/device-1/stream.mjpeg',
        wsUrl: 'ws://127.0.0.1:3200/helper/device-1/ws'
      },
      'device-1'
    )
    const explicit = parseServeSimDetachedSession(
      {
        streamUrl: 'http://127.0.0.1:3200/stream.mjpeg',
        wsUrl: 'ws://127.0.0.1:3200/ws',
        axUrl: 'http://127.0.0.1:3200/custom-ax'
      },
      'device-1'
    )

    expect(derived.axUrl).toBe('http://127.0.0.1:3200/helper/device-1/ax')
    expect(explicit.axUrl).toBe('http://127.0.0.1:3200/custom-ax')
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

describe('deriveAxUrlFromStreamUrl', () => {
  it('swaps the mjpeg stream suffix for /ax', () => {
    expect(deriveAxUrlFromStreamUrl('http://127.0.0.1:3100/stream.mjpeg')).toBe(
      'http://127.0.0.1:3100/ax'
    )
    expect(deriveAxUrlFromStreamUrl('http://127.0.0.1:3200/helper/device-1/stream.mjpeg')).toBe(
      'http://127.0.0.1:3200/helper/device-1/ax'
    )
  })

  it('never fabricates an /ax endpoint from a non-mjpeg or missing url', () => {
    expect(deriveAxUrlFromStreamUrl('http://127.0.0.1:3100/stream.h264')).toBeUndefined()
    expect(deriveAxUrlFromStreamUrl('http://127.0.0.1:3100/')).toBeUndefined()
    expect(deriveAxUrlFromStreamUrl(undefined)).toBeUndefined()
  })
})
