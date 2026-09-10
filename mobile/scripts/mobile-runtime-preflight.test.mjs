import { describe, expect, it, vi } from 'vitest'
import {
  MobileRuntimePreflightError,
  verifyMobileRuntimePreflight
} from './mobile-runtime-preflight.mjs'

function metroStatus(body = 'packager-status:running', status = 200) {
  return new Response(body, { status })
}

describe('mobile runtime preflight', () => {
  it('rejects loopback publication for a physical device with a concrete recovery command', async () => {
    await expect(
      verifyMobileRuntimePreflight({
        publishedUrl: 'http://127.0.0.1:8081',
        target: 'physical',
        fetchStatus: vi.fn()
      })
    ).rejects.toMatchObject({
      stage: 'bundle_readiness',
      code: 'loopback_publication',
      recoveryCommand: 'pnpm start -- --host lan --port 8081'
    })
  })

  it('configures Android reverse before publishing the emulator URL', async () => {
    const events = []
    const result = await verifyMobileRuntimePreflight({
      publishedUrl: 'http://localhost:8081',
      target: 'android-emulator',
      configureAndroidReverse: vi.fn(async (port) => events.push(`reverse:${port}`)),
      fetchStatus: vi.fn(async (url) => {
        events.push(`fetch:${url.toString()}`)
        return metroStatus()
      })
    })

    expect(events).toEqual(['reverse:8081', 'fetch:http://localhost:8081/status'])
    expect(result.deviceUrl).toBe('http://127.0.0.1:8081')
    expect(result.recoveryCommand).toContain('adb reverse tcp:8081 tcp:8081')
  })

  it('surfaces a Metro no-result response instead of opening the runtime', async () => {
    await expect(
      verifyMobileRuntimePreflight({
        publishedUrl: 'http://192.168.1.20:8081',
        target: 'physical',
        fetchStatus: vi.fn(async () =>
          metroStatus('UnexpectedServerData: No returned query result')
        )
      })
    ).rejects.toMatchObject({
      code: 'metro_unexpected_response',
      message: expect.stringContaining('UnexpectedServerData: No returned query result')
    })
  })

  it('retains a Java I/O error code with the failed bundle stage', async () => {
    const javaIoError = new Error('java.io.IOException: connection refused')
    Object.assign(javaIoError, { code: 'UnexpectedServerData' })

    await expect(
      verifyMobileRuntimePreflight({
        publishedUrl: 'http://192.168.1.20:8081',
        target: 'physical',
        fetchStatus: vi.fn().mockRejectedValue(javaIoError)
      })
    ).rejects.toEqual(
      expect.objectContaining({
        stage: 'bundle_readiness',
        code: 'metro_unreachable',
        message: expect.stringContaining('UnexpectedServerData: java.io.IOException')
      })
    )
  })

  it('bounds an upstream Metro response while preserving the response status', async () => {
    const error = await verifyMobileRuntimePreflight({
      publishedUrl: 'http://localhost:8081',
      target: 'web',
      fetchStatus: vi.fn(async () => metroStatus(`token=private ${'x'.repeat(1_000)}`, 503))
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(MobileRuntimePreflightError)
    expect(error.message).toContain('Metro returned 503')
    expect(error.message).toContain('token=[REDACTED]')
    expect(error.message).not.toContain('private')
    expect(error.message.length).toBeLessThan(300)
  })
})
