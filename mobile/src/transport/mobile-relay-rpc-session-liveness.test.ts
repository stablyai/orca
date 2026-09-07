import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const fakes = vi.hoisted(() => ({
  linkOptions: null as null | {
    onHello(value: unknown): void
    onAuthenticated(): void
    onText(value: string): void
    onBinary(value: Uint8Array): void
  },
  sendText: vi.fn(() => true),
  close: vi.fn()
}))

vi.mock('./mobile-relay-e2ee-link', () => ({
  MobileRelayE2eeLink: class {
    constructor(options: NonNullable<typeof fakes.linkOptions>) {
      fakes.linkOptions = options
    }
    sendText = fakes.sendText
    close = fakes.close
  }
}))

import { connectMobileRelayRpcSession } from './mobile-relay-rpc-session'
import type { ConnectionLogSink } from './types'

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

async function authenticateSession(
  onLog?: ConnectionLogSink,
  isForeground: () => boolean = () => true
) {
  const session = connectMobileRelayRpcSession({
    relay,
    resumeToken: 'resume-secret',
    resumeCredentialVersion: 3,
    resumeConfirmReqId: 'confirm-1',
    deviceToken: 'device-token',
    desktopPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    requestTimeoutMs: 30_000,
    isForeground,
    onLog
  })
  fakes.linkOptions!.onHello({
    type: 'relay-hello',
    ok: true,
    credentialKind: 'resume',
    leaseExpiresAt: Date.now() + 60_000,
    acceptedCredentialVersion: 3,
    acceptedAs: 'current',
    resumeExpiresAt: Date.now() + 300_000
  })
  // Authentication publishes 'connected' and puts both advisories on the wire.
  fakes.linkOptions!.onAuthenticated()
  const [confirmation, capabilities] = sentRequests()
  fakes.linkOptions!.onText(
    JSON.stringify({
      id: confirmation!.id,
      ok: true,
      result: {
        v: 1,
        relay,
        resumeConfirmation: {
          v: 1,
          reqId: 'confirm-1',
          currentVersion: 3,
          acceptedAs: 'current',
          renewed: true,
          resumeExpiresAt: Date.now() + 300_000
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
  )
  fakes.linkOptions!.onText(
    JSON.stringify({
      id: capabilities!.id,
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime-1' }
    })
  )
  await session.whenResumeConfirmed()
  expect(session.getState()).toBe('connected')
  fakes.sendText.mockClear()
  return session
}

function sentRequests(): Array<{ id: string; method: string }> {
  return fakes.sendText.mock.calls.map(
    ([value]) => JSON.parse(value as string) as { id: string; method: string }
  )
}

function answerProbe(): void {
  const probe = sentRequests().at(-1)!
  fakes.linkOptions!.onText(
    JSON.stringify({ id: probe.id, ok: true, result: {}, _meta: { runtimeId: 'r1' } })
  )
}

describe('mobile relay RPC session liveness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    fakes.linkOptions = null
    fakes.sendText.mockReturnValue(true)
  })
  afterEach(() => vi.useRealTimers())

  it('sweeps an idle foregrounded relay once per idle interval', async () => {
    const session = await authenticateSession()

    await vi.advanceTimersByTimeAsync(24_999)
    expect(fakes.sendText).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sentRequests().map(({ method }) => method)).toEqual(['status.get'])
    answerProbe()

    // Inbound traffic re-arms the sweep rather than stacking probes on it.
    await vi.advanceTimersByTimeAsync(24_999)
    expect(fakes.sendText).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(fakes.sendText).toHaveBeenCalledTimes(2)
    expect(session.getState()).toBe('connected')
    session.close()
  })

  it('spends no idle probe while the app is backgrounded', async () => {
    let foreground = true
    const session = await authenticateSession(undefined, () => foreground)
    foreground = false

    await vi.advanceTimersByTimeAsync(120_000)

    expect(fakes.sendText).not.toHaveBeenCalled()
    expect(session.getState()).toBe('connected')

    // The resume that follows probes at once instead of waiting out the sweep.
    foreground = true
    session.notifyForeground('app-resume')
    expect(sentRequests().map(({ method }) => method)).toEqual(['status.get'])
    session.close()
  })

  it('terminates a relay whose socket died in the background on two 2s resume misses', async () => {
    const onLog = vi.fn<ConnectionLogSink>()
    const session = await authenticateSession(onLog)

    session.notifyForeground('app-resume')
    expect(fakes.sendText).toHaveBeenCalledOnce()
    // Why: the first frame after a resume rides a cold radio, so one slow answer is
    // tolerated — but the verdict still lands at 4s instead of the old 8s.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(session.getState()).toBe('connected')
    expect(fakes.sendText).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(session.getState()).toBe('connected')
    await vi.advanceTimersByTimeAsync(1)

    expect(session.getState()).toBe('disconnected')
    expect(fakes.close).toHaveBeenCalledOnce()
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'liveness-timeout',
        detail: expect.stringMatching(/^probe-timeout; 2\/2 probes missed;/)
      })
    )
  })

  it('still terminates a dead relay when the log sink throws on the timeout line', async () => {
    const onLog = vi.fn<ConnectionLogSink>(() => {
      throw new Error('sink exploded')
    })
    const session = await authenticateSession(onLog)

    session.notifyForeground('focus')
    await vi.advanceTimersByTimeAsync(4_000)
    await vi.advanceTimersByTimeAsync(4_000)

    // The line was attempted and threw; the session still came down.
    expect(onLog).toHaveBeenCalledWith(expect.objectContaining({ code: 'liveness-timeout' }))
    expect(session.getState()).toBe('disconnected')
    expect(fakes.close).toHaveBeenCalledOnce()
  })

  it('disconnects after two fair foreground misses', async () => {
    const onLog = vi.fn<ConnectionLogSink>()
    const session = await authenticateSession(onLog)

    session.notifyForeground('focus')
    expect(sentRequests().map(({ method }) => method)).toEqual(['status.get'])
    await vi.advanceTimersByTimeAsync(4_000)
    expect(session.getState()).toBe('connected')
    expect(fakes.sendText).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4_000)

    expect(session.getState()).toBe('disconnected')
    expect(fakes.close).toHaveBeenCalledOnce()
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'liveness-timeout',
        path: 'relay',
        message: 'Relay health check failed',
        detail: expect.stringMatching(
          /^probe-timeout; 2\/2 probes missed; last authenticated activity \d+ms ago$/
        )
      })
    )
  })

  it('uses distinct liveness evidence IDs for sessions created in the same millisecond', async () => {
    vi.setSystemTime(1_000)
    const firstLog = vi.fn<ConnectionLogSink>()
    const first = await authenticateSession(firstLog)
    first.notifyForeground('focus')
    await vi.advanceTimersByTimeAsync(8_000)
    const firstId = firstLog.mock.calls[0]?.[0].id

    vi.clearAllMocks()
    fakes.sendText.mockReturnValue(true)
    vi.setSystemTime(1_000)
    const secondLog = vi.fn<ConnectionLogSink>()
    const second = await authenticateSession(secondLog)
    second.notifyForeground('focus')
    await vi.advanceTimersByTimeAsync(8_000)
    const secondId = secondLog.mock.calls[0]?.[0].id

    expect(firstId).toBeTruthy()
    expect(secondId).toBeTruthy()
    expect(secondId).not.toBe(firstId)
  })

  it('rate-limits focus nudges but never an app resume', async () => {
    const session = await authenticateSession()
    session.notifyForeground('focus')
    answerProbe()

    session.notifyForeground('focus')
    await vi.advanceTimersByTimeAsync(9_999)
    expect(fakes.sendText).toHaveBeenCalledOnce()

    // The resume owns the only evidence that the suspended socket is still alive.
    session.notifyForeground('app-resume')
    expect(fakes.sendText).toHaveBeenCalledTimes(2)
    answerProbe()
    session.notifyForeground('focus')
    expect(fakes.sendText).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    session.notifyForeground('focus')

    expect(fakes.sendText).toHaveBeenCalledTimes(3)
    session.close()
  })

  it('does not probe the old relay on a network change', async () => {
    const session = await authenticateSession()

    session.notifyForeground('network-change')

    expect(fakes.sendText).not.toHaveBeenCalled()
    session.close()
  })

  it('does not probe when work follows inbound silence', async () => {
    const session = await authenticateSession()
    await vi.advanceTimersByTimeAsync(20_000)

    const pending = session.sendRequest('terminal.send', { terminal: 'term', text: 'hi' })
    const outcome = pending.catch(() => undefined)
    session.subscribe('terminal.subscribe', { terminal: 'term' }, vi.fn())
    await vi.advanceTimersByTimeAsync(0)

    expect(sentRequests().map(({ method }) => method)).toEqual([
      'terminal.send',
      'terminal.subscribe'
    ])
    session.close()
    await outcome
  })

  it('fails immediately when a liveness probe cannot be written', async () => {
    const session = await authenticateSession()
    fakes.sendText.mockReturnValue(false)

    session.notifyForeground('focus')

    expect(session.getState()).toBe('disconnected')
    expect(fakes.close).toHaveBeenCalledOnce()
  })
})
