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

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

async function authenticateSession() {
  const session = connectMobileRelayRpcSession({
    relay,
    resumeToken: 'resume-secret',
    resumeCredentialVersion: 3,
    resumeConfirmReqId: 'confirm-1',
    deviceToken: 'device-token',
    desktopPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    requestTimeoutMs: 30_000
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
  fakes.linkOptions!.onAuthenticated()
  await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
  const confirmation = sentRequests()[0]!
  fakes.linkOptions!.onText(
    JSON.stringify({
      id: confirmation.id,
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
  await vi.waitFor(() => expect(session.getState()).toBe('connected'))
  fakes.sendText.mockClear()
  return session
}

function sentRequests(): Array<{ id: string; method: string }> {
  return fakes.sendText.mock.calls.map(
    ([value]) => JSON.parse(value as string) as { id: string; method: string }
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

  it('sends no periodic traffic while an authenticated relay is idle', async () => {
    const session = await authenticateSession()

    await vi.advanceTimersByTimeAsync(60_000)

    expect(fakes.sendText).not.toHaveBeenCalled()
    expect(session.getState()).toBe('connected')
    session.close()
  })

  it('disconnects after two fair foreground misses', async () => {
    const session = await authenticateSession()

    session.notifyForeground('focus')
    expect(sentRequests().map(({ method }) => method)).toEqual(['status.get'])
    await vi.advanceTimersByTimeAsync(4_000)
    expect(session.getState()).toBe('connected')
    expect(fakes.sendText).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4_000)

    expect(session.getState()).toBe('disconnected')
    expect(fakes.close).toHaveBeenCalledOnce()
  })

  it('rate-limits foreground sequences without suppressing a retry', async () => {
    const session = await authenticateSession()
    session.notifyForeground('focus')
    const firstProbe = sentRequests()[0]!
    fakes.linkOptions!.onText(
      JSON.stringify({ id: firstProbe.id, ok: true, result: {}, _meta: { runtimeId: 'r1' } })
    )

    session.notifyForeground('focus')
    await vi.advanceTimersByTimeAsync(9_999)
    session.notifyForeground('app-resume')
    expect(fakes.sendText).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    session.notifyForeground('focus')

    expect(fakes.sendText).toHaveBeenCalledTimes(2)
    session.close()
  })

  it('does not probe the old relay on a network change', async () => {
    const session = await authenticateSession()

    session.notifyForeground('network-change')

    expect(fakes.sendText).not.toHaveBeenCalled()
    session.close()
  })

  it('does not probe when work follows prolonged inbound silence', async () => {
    const session = await authenticateSession()
    await vi.advanceTimersByTimeAsync(60_000)

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
