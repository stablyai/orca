import { afterEach, expect, it } from 'vitest'
import { setActiveSink } from '../../observability/tracer'
import { sharedControlEnvironmentPolicy } from './runtime-environment-shared-control-policy'

afterEach(() => setActiveSink(null))

it('traces each control socket close for the support bundle', () => {
  const records: unknown[] = []
  setActiveSink({ push: (record) => records.push(record), flush() {}, close() {} })

  sharedControlEnvironmentPolicy('env-1').onSocketClosed?.({
    cause: 'keepalive_timeout',
    errorCode: 'remote_runtime_unavailable',
    closeCode: null,
    state: 'ready',
    lastRttMs: 320,
    socketUptimeMs: 60_000,
    readyUptimeMs: 59_000,
    reconnectAttempt: 0,
    pendingRequestCount: 1,
    subscriptionCount: 4
  })

  expect(records).toEqual([
    expect.objectContaining({
      type: 'effect-span',
      name: 'remote-runtime.control-socket-close',
      attributes: expect.objectContaining({
        environmentId: 'env-1',
        cause: 'keepalive_timeout',
        lastRttMs: 320,
        socketUptimeMs: 60_000
      })
    })
  ])
})
