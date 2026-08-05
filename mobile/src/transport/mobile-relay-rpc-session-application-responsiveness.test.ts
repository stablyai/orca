import { beforeEach, describe, expect, it, vi } from 'vitest'

const fakes = vi.hoisted(() => ({
  linkOptions: null as null | {
    onHello(value: unknown): void
    onAuthenticated(): void
    onText(value: string): void
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
import { RpcApplicationResponsiveness } from './rpc-application-responsiveness'

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

async function authenticateSession(options?: {
  applicationResponsiveness?: RpcApplicationResponsiveness
  // Fake timers stop vi.waitFor from settling, so let those cases drain microtasks instead.
  tick?: () => Promise<void>
}) {
  const session = connectMobileRelayRpcSession({
    relay,
    resumeToken: 'resume-secret',
    resumeCredentialVersion: 3,
    resumeConfirmReqId: 'confirm-1',
    deviceToken: 'device-token',
    desktopPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    requestTimeoutMs: 1000,
    ...(options?.applicationResponsiveness
      ? { applicationResponsiveness: options.applicationResponsiveness }
      : {})
  })
  const settle = options?.tick
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
  await (settle?.() ?? vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce()))
  const request = JSON.parse(fakes.sendText.mock.calls[0]![0] as string) as { id: string }
  fakes.linkOptions!.onText(
    JSON.stringify({
      id: request.id,
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
  await (settle?.() ?? vi.waitFor(() => expect(session.getState()).toBe('connected')))
  expect(session.getState()).toBe('connected')
  fakes.sendText.mockClear()
  return session
}

describe('mobile relay subscription application responsiveness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakes.linkOptions = null
    fakes.sendText.mockReturnValue(true)
  })

  it('does not clear an inherited stall during resume confirmation', async () => {
    const responsiveness = new RpcApplicationResponsiveness()
    responsiveness.recordControlPlaneFailure()

    const session = await authenticateSession({ applicationResponsiveness: responsiveness })

    expect(responsiveness.getUnresponsiveSince()).not.toBeNull()
    session.close()
  })

  it('keeps an application stall latched when only a subscription answers', async () => {
    const session = await authenticateSession()
    vi.useFakeTimers()
    try {
      const first = session
        .sendRequest('browser.screenshot', {}, { timeoutMs: 100, applicationHealthProbe: true })
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(100)
      await expect(first).resolves.toMatchObject({
        message: 'relay RPC timed out: browser.screenshot'
      })
      expect(session.getRpcUnresponsiveSince?.()).not.toBeNull()

      session.subscribe('terminal.subscribe', { terminal: 'term-1' }, vi.fn())
      await vi.advanceTimersByTimeAsync(0)
      const subscribe = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { id: string; method: string })
        .find(({ method }) => method === 'terminal.subscribe')!
      fakes.linkOptions!.onText(
        JSON.stringify({
          id: subscribe.id,
          ok: true,
          streaming: true,
          result: { type: 'subscribed', streamId: 42 },
          _meta: {}
        })
      )
      expect(session.getRpcUnresponsiveSince?.()).not.toBeNull()

      const second = session
        .sendRequest('browser.screenshot', {}, { timeoutMs: 100, applicationHealthProbe: true })
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(100)
      await expect(second).resolves.toMatchObject({
        message: 'relay RPC timed out: browser.screenshot'
      })
      expect(session.getState()).toBe('disconnected')
      expect(fakes.close).toHaveBeenCalledOnce()
    } finally {
      session.close()
      vi.useRealTimers()
    }
  })

  it('keeps ordinary request timeouts out of the shared health verdict', async () => {
    const session = await authenticateSession()
    vi.useFakeTimers()
    try {
      const first = session
        .sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(100)

      await expect(first).resolves.toMatchObject({
        message: 'relay RPC timed out: browser.screenshot'
      })
      expect(session.getRpcUnresponsiveSince?.()).toBeNull()

      const second = session
        .sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(100)

      await expect(second).resolves.toMatchObject({
        message: 'relay RPC timed out: browser.screenshot'
      })
      expect(session.getRpcUnresponsiveSince?.()).toBeNull()
      expect(session.getState()).toBe('connected')
      expect(fakes.close).not.toHaveBeenCalled()
    } finally {
      session.close()
      vi.useRealTimers()
    }
  })

  it('latches the shared verdict when the control probe demotes a wedged session', async () => {
    vi.useFakeTimers()
    const responsiveness = new RpcApplicationResponsiveness()
    try {
      const session = await authenticateSession({
        applicationResponsiveness: responsiveness,
        tick: () => vi.advanceTimersByTimeAsync(0)
      })
      // 20s probe interval + 8s probe timeout, with no inbound frame to extend it.
      await vi.advanceTimersByTimeAsync(28_000)
      expect(session.getState()).toBe('disconnected')
      // The supervisor's replacement session inherits this instance, so the next
      // authenticated relay session cannot report a bare 'Connected'.
      expect(responsiveness.getUnresponsiveSince()).not.toBeNull()
      session.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
