import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserScreencastOpcode,
  encodeBrowserScreencastFrame
} from '../../../src/shared/browser-screencast-protocol'
import { encodeTerminalStreamFrame, TerminalStreamOpcode } from './terminal-stream-protocol'
import { isRpcDeliveryUnknown } from './rpc-delivery-ambiguity'

const fakes = vi.hoisted(() => ({
  linkOptions: null as null | {
    endpoint: { cellUrl: string; relayHostId: string }
    credential: string
    expectedCredentialKind: string
    onOpen(): void
    onHello(value: unknown): void
    onAuthenticated(): void
    onText(value: string): void
    onBinary(value: Uint8Array): void
    onError(error: Error): void
  },
  sendText: vi.fn(() => true),
  close: vi.fn()
}))

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

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
import { persistResumeConfirmation } from './mobile-relay-credential-rotation'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

type SentRequest = {
  id: string
  method: string
  deviceToken: string
  params: Record<string, unknown> | undefined
}

function openSession() {
  return connectMobileRelayRpcSession({
    relay,
    resumeToken: 'resume-secret',
    resumeCredentialVersion: 3,
    resumeConfirmReqId: 'confirm-1',
    deviceToken: 'device-token',
    desktopPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    requestTimeoutMs: 1000
  })
}

function sentRequests(): SentRequest[] {
  return fakes.sendText.mock.calls.map(([value]) => JSON.parse(value as string) as SentRequest)
}

function receiveHello(): void {
  fakes.linkOptions!.onHello({
    type: 'relay-hello',
    ok: true,
    credentialKind: 'resume',
    leaseExpiresAt: Date.now() + 60_000,
    acceptedCredentialVersion: 3,
    acceptedAs: 'current',
    resumeExpiresAt: Date.now() + 300_000
  })
}

// E2EE authentication alone publishes 'connected'; the confirm and the capability
// advisory are already on the wire by the time it returns.
function authenticateSession() {
  const session = openSession()
  receiveHello()
  expect(session.getState()).toBe('handshaking')
  fakes.linkOptions!.onAuthenticated()
  const [confirmationRequest, capabilityRequest] = sentRequests()
  return {
    session,
    confirmationRequest: confirmationRequest!,
    capabilityRequest: capabilityRequest!
  }
}

function answerConfirm(request: SentRequest, relayHostId = relay.relayHostId): void {
  fakes.linkOptions!.onText(
    JSON.stringify({
      id: request.id,
      ok: true,
      result: {
        v: 1,
        relay: { ...relay, relayHostId },
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
}

function answerCapability(request: SentRequest, supported = true): void {
  fakes.linkOptions!.onText(
    JSON.stringify(
      supported
        ? { id: request.id, ok: true, result: request.params, _meta: { runtimeId: 'runtime-1' } }
        : {
            id: request.id,
            ok: false,
            error: { code: 'method_not_found', message: 'Unknown method' },
            _meta: { runtimeId: 'runtime-1' }
          }
    )
  )
}

// Both advisories answered and the send log cleared, so a test can read its own frames.
async function settledSession(capabilitySupported = true) {
  const authenticated = authenticateSession()
  answerConfirm(authenticated.confirmationRequest)
  answerCapability(authenticated.capabilityRequest, capabilitySupported)
  await authenticated.session.whenResumeConfirmed()
  expect(authenticated.session.getState()).toBe('connected')
  fakes.sendText.mockClear()
  return authenticated
}

describe('mobile relay RPC session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakes.linkOptions = null
    fakes.sendText.mockReturnValue(true)
  })
  afterEach(() => vi.useRealTimers())

  it('releases stream listeners on failure even when close follows it', async () => {
    const { session } = await settledSession()
    const listener = vi.fn()
    session.subscribe('runtime.clientEvents.subscribe', {}, listener)
    await Promise.resolve()
    const request = JSON.parse(fakes.sendText.mock.calls[0]![0] as string) as { id: string }
    fakes.linkOptions!.onText(
      JSON.stringify({
        id: request.id,
        ok: true,
        streaming: true,
        result: { type: 'ready', subscriptionId: 'server-events' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    expect(listener).toHaveBeenCalledTimes(1)
    fakes.linkOptions!.onError(new Error('relay lost'))
    session.close()
    fakes.linkOptions!.onText(
      JSON.stringify({
        id: request.id,
        ok: true,
        streaming: true,
        result: { type: 'event' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('sends the resume confirm by request ID and the capability advisory concurrently', async () => {
    const { session, confirmationRequest, capabilityRequest } = await settledSession()

    expect(fakes.linkOptions).toMatchObject({
      endpoint: relay,
      credential: 'resume-secret',
      expectedCredentialKind: 'resume'
    })
    expect(confirmationRequest).toMatchObject({
      method: 'pairing.getEndpoints',
      params: { resumeConfirmReqId: 'confirm-1' },
      deviceToken: 'device-token'
    })
    expect(confirmationRequest.params).not.toHaveProperty('relayDeviceId')
    expect(confirmationRequest.params).not.toHaveProperty('acceptedCredentialVersion')
    expect(capabilityRequest).toMatchObject({
      method: 'runtime.clientCapabilities.update',
      params: {
        clientCapabilities: expect.arrayContaining(['agent-session.structured.v1'])
      },
      deviceToken: 'device-token'
    })
    expect(session.getAttachDeadlineAt()).toEqual(expect.any(Number))
  })

  it('connects when an older runtime rejects capability negotiation', async () => {
    const { session } = await settledSession(false)

    expect(session.getState()).toBe('connected')
    expect(session.getFailure()).toBeNull()
  })

  it('connects when the relay never answers capability negotiation', async () => {
    const { session, confirmationRequest } = authenticateSession()
    answerConfirm(confirmationRequest)

    // Why: the advisory's own deadline used to fail the confirm, so a link too slow to
    // answer within the request timeout never published 'connected' — it just redialled.
    await session.whenResumeConfirmed()
    expect(session.getState()).toBe('connected')
    expect(session.getFailure()).toBeNull()
  })

  it('publishes connected at authentication, ahead of the confirm answer', async () => {
    const states: string[] = []
    const session = openSession()
    session.onStateChange((state) => states.push(state))
    receiveHello()
    fakes.linkOptions!.onAuthenticated()

    // Why: the transport carries traffic from here; two serialized advisory round
    // trips used to add ~200ms to every phone reconnect before anything rendered.
    expect(session.getState()).toBe('connected')
    expect(states).toEqual(['handshaking', 'connected'])
    expect(session.getResumeConfirmation()).toBeNull()
    expect(sentRequests().map(({ method }) => method)).toEqual([
      'pairing.getEndpoints',
      'runtime.clientCapabilities.update'
    ])

    const [confirmationRequest] = sentRequests()
    answerConfirm(confirmationRequest!)
    await session.whenResumeConfirmed()
    expect(session.getResumeConfirmation()).toMatchObject({ reqId: 'confirm-1' })
    session.close()
  })

  it('fails a session whose confirm answers for another relay host after connected', async () => {
    const { session, confirmationRequest } = authenticateSession()
    expect(session.getState()).toBe('connected')

    answerConfirm(confirmationRequest, 'ZZZZZZZZZZZZZZZZ')
    await session.whenResumeConfirmed()

    // A late failure is fine; a lost one is not.
    expect(session.getState()).toBe('disconnected')
    expect(session.getFailure()?.message).toBe('relay resume confirmation missing')
    expect(fakes.close).toHaveBeenCalledOnce()
  })

  it('fails a session whose confirm never answers', async () => {
    vi.useFakeTimers()
    try {
      const { session } = authenticateSession()
      expect(session.getState()).toBe('connected')

      await vi.advanceTimersByTimeAsync(1_000)

      expect(session.getState()).toBe('disconnected')
      expect(session.getFailure()?.message).toBe('relay RPC timed out: pairing.getEndpoints')
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands the landed confirmation to resume persistence', async () => {
    const { session, confirmationRequest } = authenticateSession()
    const bundle: MobileRelayCredentialBundle = {
      v: 1,
      hostId: 'host-1',
      deviceToken: 'device-token',
      current: { token: 'A'.repeat(43), hash: 'B'.repeat(43), version: 3, expiresAt: 1 }
    }
    const writeBundle = vi.fn(async () => {})
    // Why: persistence runs right after the migration, while the confirm is still
    // in flight — it must wait for the answer instead of reading a null.
    const persisting = persistResumeConfirmation({
      session,
      bundle,
      usedCredentialVersion: 3,
      writeBundle
    })
    expect(writeBundle).not.toHaveBeenCalled()

    answerConfirm(confirmationRequest)
    const applied = await persisting

    expect(writeBundle).toHaveBeenCalledOnce()
    expect(applied.bundle.current.expiresAt).toBe(session.getResumeExpiresAt())
    expect(applied.leaseExpiry).toBe(session.getResumeExpiresAt())
    session.close()
  })

  // Why: ConnectionState stays 'connecting' until relay-hello, so the migration bound
  // needs a separate signal to tell "cell never answered the upgrade" from "cell took
  // relay-auth and is still resolving the assignment".
  it('reports the dial stage as the link opens, receives hello, and authenticates', async () => {
    const session = openSession()
    const stages: string[] = []
    session.onDialStageChange((stage) => stages.push(stage))
    expect(session.getDialStage()).toBe('opening')

    fakes.linkOptions!.onOpen()
    expect(session.getDialStage()).toBe('awaiting-hello')
    expect(session.getState()).toBe('connecting')
    fakes.linkOptions!.onHello({
      type: 'relay-hello',
      ok: true,
      credentialKind: 'resume',
      leaseExpiresAt: Date.now() + 10_000,
      acceptedCredentialVersion: 3,
      acceptedAs: 'current',
      resumeExpiresAt: Date.now() + 300_000
    })
    expect(session.getDialStage()).toBe('handshaking')
    fakes.linkOptions!.onAuthenticated()
    expect(session.getDialStage()).toBe('confirming')
    expect(fakes.sendText).toHaveBeenCalledTimes(2)
    expect(stages).toEqual(['awaiting-hello', 'handshaking', 'confirming'])
    session.close()
  })

  it('rejects a mismatched outer credential version and closes the physical link', () => {
    const session = openSession()
    fakes.linkOptions!.onHello({
      type: 'relay-hello',
      ok: true,
      credentialKind: 'resume',
      leaseExpiresAt: Date.now() + 60_000,
      acceptedCredentialVersion: 2,
      acceptedAs: 'grace',
      resumeExpiresAt: Date.now() + 300_000
    })

    expect(session.getState()).toBe('disconnected')
    expect(fakes.close).toHaveBeenCalledOnce()
    expect(fakes.sendText).not.toHaveBeenCalled()
  })

  it('routes terminal and browser binary streams after confirmation', async () => {
    const { session } = await settledSession()
    const terminalListener = vi.fn()
    session.subscribe('terminal.subscribe', { terminal: 'term-1' }, terminalListener)
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
    const terminalRequest = JSON.parse(fakes.sendText.mock.calls[0]![0] as string) as {
      id: string
    }
    fakes.linkOptions!.onText(
      JSON.stringify({
        id: terminalRequest.id,
        ok: true,
        result: { streamId: 42 },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    fakes.linkOptions!.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: 42,
        seq: 1,
        payload: new TextEncoder().encode('hello')
      })
    )
    expect(terminalListener).toHaveBeenLastCalledWith({
      type: 'data',
      streamId: 42,
      chunk: 'hello'
    })

    fakes.sendText.mockClear()
    const onBinaryFrame = vi.fn()
    session.subscribe('browser.screencast', {}, vi.fn(), { onBinaryFrame })
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
    const browserRequest = JSON.parse(fakes.sendText.mock.calls[0]![0] as string) as { id: string }
    fakes.linkOptions!.onText(
      JSON.stringify({
        id: browserRequest.id,
        ok: true,
        result: { subscriptionId: 'browser-1' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    fakes.linkOptions!.onBinary(
      encodeBrowserScreencastFrame({
        opcode: BrowserScreencastOpcode.Frame,
        seq: 9,
        format: 'jpeg',
        metadata: { imageWidth: 800 },
        image: new Uint8Array([1, 2, 3])
      })
    )
    expect(onBinaryFrame).toHaveBeenCalledWith(
      expect.objectContaining({ seq: 9, format: 'jpeg', image: new Uint8Array([1, 2, 3]) })
    )
  })

  it('rejects pending RPC work when the physical link fails', async () => {
    const { session } = await settledSession()
    const pending = session.sendRequest('status.get')
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
    fakes.linkOptions!.onError(new Error('relay transport error'))

    await expect(pending).rejects.toThrow('relay transport error')
    // The frame reached the wire, so the failure must read as delivery-unknown.
    await expect(pending.catch((error: unknown) => isRpcDeliveryUnknown(error))).resolves.toBe(true)
    expect(session.getState()).toBe('disconnected')
  })

  it('marks in-flight requests delivery-unknown when the session closes', async () => {
    const { session } = await settledSession()
    const pending = session.sendRequest('terminal.send', { terminal: 'term', text: 'hi' })
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
    session.close()

    await expect(pending).rejects.toThrow('Client closed')
    await expect(pending.catch((error: unknown) => isRpcDeliveryUnknown(error))).resolves.toBe(true)
  })

  it('marks a relay RPC timeout delivery-unknown', async () => {
    const { session } = await settledSession()
    vi.useFakeTimers()
    try {
      const pending = session.sendRequest('terminal.send', { terminal: 'term', text: 'hi' })
      const outcome = pending.catch((error: unknown) => ({
        message: (error as Error).message,
        unknown: isRpcDeliveryUnknown(error)
      }))
      // Let sendRequest pass its connected-check microtask and register the timer.
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(outcome).resolves.toEqual({
        message: 'relay RPC timed out: terminal.send',
        unknown: true
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
