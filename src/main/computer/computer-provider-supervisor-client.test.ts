import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputerProviderSupervisorClient } from './computer-provider-supervisor-client'
import {
  COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
  type ComputerProviderSupervisorRequest
} from './computer-provider-supervisor-protocol'

describe('ComputerProviderSupervisorClient', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts only the fixed macOS operation and observes early helper termination', async () => {
    const sent: ComputerProviderSupervisorRequest[] = []
    const client = new ComputerProviderSupervisorClient((message, callback) => {
      sent.push(message)
      callback(null)
    })

    const start = client.startMacOSProvider()
    expect(sent).toEqual([
      {
        channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
        kind: 'request',
        id: 1,
        method: 'macos.start',
        params: {}
      }
    ])
    client.handleMessage({
      channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
      kind: 'event',
      event: 'macos.sessionTerminated',
      sessionId: 'session-1',
      error: { code: 'accessibility_error', message: 'helper exited before connect' }
    })
    client.handleMessage({
      channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
      kind: 'response',
      id: 1,
      ok: true,
      result: {
        sessionId: 'session-1',
        socketPath: '/tmp/session-1/provider.sock',
        socketToken: 'token-1'
      }
    })

    const started = await start
    expect(started).toMatchObject({
      sessionId: 'session-1',
      socketPath: '/tmp/session-1/provider.sock',
      socketToken: 'token-1'
    })
    await expect(started.termination).rejects.toThrow('helper exited before connect')
  })

  it('uses fixed claim and release requests for a returned session id', async () => {
    const sent: ComputerProviderSupervisorRequest[] = []
    const client = new ComputerProviderSupervisorClient((message, callback) => {
      sent.push(message)
      callback(null)
    })

    const claim = client.claimMacOSProvider('session-1')
    client.handleMessage({
      channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
      kind: 'response',
      id: 1,
      ok: true,
      result: { claimed: true }
    })
    await claim

    const release = client.releaseMacOSProvider('session-1')
    client.handleMessage({
      channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
      kind: 'response',
      id: 2,
      ok: true,
      result: { released: true }
    })
    await release

    expect(sent.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: 'macos.claim', params: { sessionId: 'session-1' } },
      { method: 'macos.release', params: { sessionId: 'session-1' } }
    ])
  })

  it('rejects immediately when supervisor IPC delivery fails', async () => {
    const client = new ComputerProviderSupervisorClient((_message, callback) => {
      callback(new Error('ipc channel closed'))
    })

    await expect(client.startMacOSProvider()).rejects.toThrow('ipc channel closed')
  })

  it('rejects malformed session metadata from the parent boundary', async () => {
    const client = new ComputerProviderSupervisorClient(() => {})
    const start = client.startMacOSProvider()
    client.handleMessage({
      channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
      kind: 'response',
      id: 1,
      ok: true,
      result: { sessionId: 'session-1', socketPath: '', socketToken: '' }
    })

    await expect(start).rejects.toThrow('returned an invalid macOS session')
  })

  it('preserves typed supervisor error responses', async () => {
    const client = new ComputerProviderSupervisorClient(() => {})
    const start = client.startMacOSProvider()
    client.handleMessage({
      channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
      kind: 'response',
      id: 1,
      ok: false,
      error: { code: 'provider_missing', message: 'helper is unavailable' }
    })

    await expect(start).rejects.toMatchObject({
      code: 'provider_missing',
      message: 'helper is unavailable'
    })
  })

  it('bounds terminated sessions whose start responses never arrived', async () => {
    const client = new ComputerProviderSupervisorClient(() => {})
    for (let session = 1; session <= 33; session++) {
      client.handleMessage({
        channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
        kind: 'event',
        event: 'macos.sessionTerminated',
        sessionId: `session-${session}`,
        error: { code: 'accessibility_error', message: `early-${session}` }
      })
    }

    const oldestStart = client.startMacOSProvider()
    client.handleMessage({
      channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
      kind: 'response',
      id: 1,
      ok: true,
      result: {
        sessionId: 'session-1',
        socketPath: '/tmp/session-1/provider.sock',
        socketToken: 'token-1'
      }
    })
    const oldest = await oldestStart
    let oldestSettled = false
    void oldest.termination.catch(() => {
      oldestSettled = true
    })
    await Promise.resolve()
    expect(oldestSettled).toBe(false)

    const newestStart = client.startMacOSProvider()
    client.handleMessage({
      channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
      kind: 'response',
      id: 2,
      ok: true,
      result: {
        sessionId: 'session-33',
        socketPath: '/tmp/session-33/provider.sock',
        socketToken: 'token-33'
      }
    })
    const newest = await newestStart
    await expect(newest.termination).rejects.toThrow('early-33')
    client.shutdown()
    await expect(oldest.termination).rejects.toThrow('channel shut down')
  })

  it('bounds an unanswered supervisor request', async () => {
    vi.useFakeTimers()
    const client = new ComputerProviderSupervisorClient(() => {})

    const start = client.startMacOSProvider()
    const rejection = expect(start).rejects.toThrow(
      'computer provider supervisor macos.start timed out'
    )
    await vi.advanceTimersByTimeAsync(10_000)

    await rejection
  })
})
