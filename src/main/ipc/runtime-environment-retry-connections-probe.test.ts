import { describe, expect, it, vi } from 'vitest'
import type * as SocketLiveness from '../../shared/remote-runtime-socket-liveness'

const probeAllRemoteRuntimeSocketsNow = vi.hoisted(() => vi.fn(() => 0))

vi.mock('../../shared/remote-runtime-socket-liveness', async (importOriginal) => ({
  ...(await importOriginal<typeof SocketLiveness>()),
  probeAllRemoteRuntimeSocketsNow
}))

import { retryRemoteRuntimeSharedControlConnectionsNow } from './runtime-environment-request-connections'

// Regression for #9092: the resume/online IPC must probe sockets that still read OPEN after wake.
describe('retryRemoteRuntimeSharedControlConnectionsNow', () => {
  it('probes every remote runtime socket even when no reconnect is pending', () => {
    retryRemoteRuntimeSharedControlConnectionsNow()

    expect(probeAllRemoteRuntimeSocketsNow).toHaveBeenCalledTimes(1)
  })
})
