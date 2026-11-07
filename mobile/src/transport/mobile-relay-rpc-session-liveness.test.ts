import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const fakes = vi.hoisted(() => ({
  linkOptions: null as null | {
    onHello(value: unknown): void
    onAuthenticated(): void
    onText(value: string): void
    onBinary(value: Uint8Array): void
  },
  sendText: vi.fn((_frame: string) => true),
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
import { RelayReconnectController } from './mobile-relay-reconnect-controller'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionLogSink } from './types'

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

async function authenticateSession(onLog?: ConnectionLogSink) {
  const session = connectMobileRelayRpcSession({
    relay,
    resumeToken: 'resume-secret',
    resumeCredentialVersion: 3,
    resumeConfirmReqId: 'confirm-1',
    deviceToken: 'device-token',
    desktopPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    requestTimeoutMs: 30_000,
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
  fakes.linkOptions!.onAuthenticated()
  await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
  const confirmation = sentRequests()[0]!
  expect(confirmation).toMatchObject({
    method: 'pairing.getEndpoints',
    params: { resumeConfirmReqId: 'confirm-1' },
    deviceToken: 'device-token'
  })
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
  await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledTimes(2))
  const capabilities = sentRequests()[1]!
  expect(capabilities).toMatchObject({
    method: 'runtime.clientCapabilities.update',
    params: { clientCapabilities: expect.arrayContaining(['agent-session.structured.v1']) },
    deviceToken: 'device-token'
  })
  fakes.linkOptions!.onText(
    JSON.stringify({
      id: capabilities.id,
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime-1' }
    })
  )
  await vi.waitFor(() => expect(session.getState()).toBe('connected'))
  fakes.sendText.mockClear()
  return session
}

function sentRequests() {
  return fakes.sendText.mock.calls.map(([value]) => {
    const request: unknown = JSON.parse(value)
    if (
      !request ||
      typeof request !== 'object' ||
      !('id' in request) ||
      typeof request.id !== 'string' ||
      !('method' in request) ||
      typeof request.method !== 'string'
    ) {
      throw new Error('Expected a serialized RPC request')
    }
    return request
  })
}

describe('mobile relay RPC session liveness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    fakes.linkOptions = null
    fakes.sendText.mockReturnValue(true)
  })
  afterEach(() => vi.useRealTimers())

  it('keeps availability returns tolerant while a proven resume bypasses recent probes', async () => {
    const session = await authenticateSession()
    const logical = createStableLogicalRpcClient(session, 'relay')
    const controller = new RelayReconnectController(
      {
        now: Date.now,
        randomBytes: (length) => new Uint8Array(length),
        setTimer: (callback, delay) => setTimeout(callback, delay),
        clearTimer: clearTimeout
      },
      vi.fn()
    )
    controller.setActiveSession(session)
    session.notifyForeground('focus')
    const probe = sentRequests()[0]
    if (!probe || !fakes.linkOptions) {
      throw new Error('Expected the focus probe')
    }
    fakes.linkOptions.onText(JSON.stringify({ id: probe.id, ok: true, result: {} }))
    await vi.advanceTimersByTimeAsync(1_000)

    // The lifecycle boolean also becomes false during an inactive-only iOS interruption.
    controller.handleForeground(logical, false)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(session.getState()).toBe('connected')
    expect(fakes.sendText).toHaveBeenCalledOnce()

    logical.notifyForeground('app-resume')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(session.getState()).toBe('disconnected')
    controller.clear()
    logical.close()
  })

  it('probes an idle relay and closes it when the probes go unanswered', async () => {
    const session = await authenticateSession()
    for (let elapsed = 0; elapsed < 30_000; elapsed += 5_000) {
      fakes.linkOptions!.onBinary(new Uint8Array([1]))
      await vi.advanceTimersByTimeAsync(5_000)
    }
    fakes.linkOptions!.onBinary(new Uint8Array([1]))
    expect(fakes.sendText).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(15_000)
    expect(sentRequests()).toEqual([
      expect.objectContaining({ method: 'status.get', params: { probe: true } })
    ])

    await vi.advanceTimersByTimeAsync(8_000)
    expect(session.getState()).toBe('disconnected')
  })

  it('keeps an idle relay open while a slow reply is still downloading', async () => {
    const session = await authenticateSession()
    await vi.advanceTimersByTimeAsync(14_000)
    const reply = session.sendRequest('files.read', { path: 'large.png' })
    await vi.advanceTimersByTimeAsync(12_000)
    expect(session.getState()).toBe('connected')
    const request = sentRequests().find(({ method }) => method === 'files.read')!

    fakes.linkOptions!.onText(JSON.stringify({ id: request.id, ok: true, result: { size: 3 } }))
    await expect(reply).resolves.toMatchObject({ ok: true, result: { size: 3 } })
    expect(session.getState()).toBe('connected')
  })

  it('closes a silent relay even while requests keep going unanswered', async () => {
    const session = await authenticateSession()
    for (let elapsed = 0; elapsed < 60_000; elapsed += 5_000) {
      session.sendRequest('status.get', {}).catch(() => {})
      await vi.advanceTimersByTimeAsync(5_000)
    }
    expect(session.getState()).toBe('disconnected')
  })

  it('keeps an idle relay open while a stream backlog delays the probe reply', async () => {
    const session = await authenticateSession()
    await vi.advanceTimersByTimeAsync(15_000)
    for (let elapsed = 0; elapsed < 12_000; elapsed += 1_000) {
      fakes.linkOptions!.onBinary(new Uint8Array([1]))
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(session.getState()).toBe('connected')
  })
})
