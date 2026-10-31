import { expect, it, vi } from 'vitest'
import { validate } from '../telemetry/validator'
import { observeDaemonAsyncIoHealth } from './daemon-async-io-telemetry-event'

const { trackMock } = vi.hoisted(() => ({
  trackMock: vi.fn((_name: 'daemon_async_io_health', _props: unknown) => true)
}))
vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '1.4.300' })
}))

it('emits one stalled and one recovered per daemon incarnation across repeated polls', () => {
  const stalled = { state: 'stalled', pendingMs: 5000 } as const
  const healthy = { state: 'healthy', pendingMs: 0 } as const
  const adopted = { pid: 1, startedAtMs: 1, launchNonce: 'a', appVersion: '1.4.299' }
  const forked = { pid: 2, startedAtMs: 2, launchNonce: 'b', appVersion: '1.4.300' }

  observeDaemonAsyncIoHealth(adopted, 51, healthy, 0)
  observeDaemonAsyncIoHealth(adopted, 51, stalled, 1_000)
  observeDaemonAsyncIoHealth({ ...adopted }, 51, stalled, 31_000)
  observeDaemonAsyncIoHealth(forked, 51, stalled, 31_000)
  observeDaemonAsyncIoHealth(adopted, 51, healthy, 121_000)
  observeDaemonAsyncIoHealth(adopted, 51, stalled, 151_000)
  observeDaemonAsyncIoHealth(adopted, 51, healthy, 181_000)

  const calls = trackMock.mock.calls
  expect(calls).toEqual([
    [
      'daemon_async_io_health',
      { transition: 'stalled', protocol_generation: 51, app_version_match: 'different' }
    ],
    [
      'daemon_async_io_health',
      { transition: 'stalled', protocol_generation: 51, app_version_match: 'same' }
    ],
    [
      'daemon_async_io_health',
      {
        transition: 'recovered',
        protocol_generation: 51,
        app_version_match: 'different',
        stalled_for_bucket: '1-5m'
      }
    ]
  ])
  for (const [name, props] of calls) {
    expect(validate(name, props).ok).toBe(true)
  }
})
