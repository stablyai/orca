import { mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deriveAxUrlFromStreamUrl,
  SERVE_SIM_STATE_FILE_MAX_BYTES,
  parseServeSimDetachedSession
} from './serve-sim-detached-session'

const stateFiles: string[] = []

function stateFileFor(udid: string): string {
  const filePath = join(tmpdir(), 'serve-sim', `server-${udid}.json`)
  mkdirSync(join(tmpdir(), 'serve-sim'), { recursive: true })
  stateFiles.push(filePath)
  return filePath
}

function detachedPayload(udid: string): Record<string, string> {
  return {
    device: udid,
    streamUrl: 'http://127.0.0.1:3100/stream.mjpeg',
    wsUrl: 'ws://127.0.0.1:3100/ws'
  }
}

afterEach(() => {
  for (const filePath of stateFiles.splice(0)) {
    rmSync(filePath, { force: true })
  }
})

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

  it('reads a helper PID state file at the exact byte boundary', () => {
    const udid = `orca-boundary-${process.pid}-${Date.now()}`
    const statePath = stateFileFor(udid)
    const state = '{"pid":4321}'
    writeFileSync(
      statePath,
      state + ' '.repeat(SERVE_SIM_STATE_FILE_MAX_BYTES - Buffer.byteLength(state))
    )

    expect(parseServeSimDetachedSession(detachedPayload(udid), udid).helperPid).toBe(4321)
  })

  it('ignores a sparse helper PID state file one byte over the boundary', () => {
    const udid = `orca-oversized-${process.pid}-${Date.now()}`
    const statePath = stateFileFor(udid)
    writeFileSync(statePath, '{"pid":4321}')
    truncateSync(statePath, SERVE_SIM_STATE_FILE_MAX_BYTES + 1)

    expect(parseServeSimDetachedSession(detachedPayload(udid), udid).helperPid).toBeUndefined()
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
