import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserScreencastOpcode,
  encodeBrowserScreencastFrame
} from '../../../src/shared/browser-screencast-protocol'
import {
  encodeTerminalStreamFrame,
  TerminalStreamOpcode
} from '../../../src/shared/terminal-stream-protocol'
import { scopeRpcClientToExecutionHost } from './execution-host-scoped-rpc-client'
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

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
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

async function confirmResume() {
  const session = openSession()
  fakes.linkOptions!.onHello({
    type: 'relay-hello',
    ok: true,
    credentialKind: 'resume',
    leaseExpiresAt: Date.now() + 60_000,
    acceptedCredentialVersion: 3,
    acceptedAs: 'current',
    resumeExpiresAt: Date.now() + 300_000
  })
  expect(session.getState()).toBe('handshaking')
  fakes.linkOptions!.onAuthenticated()
  await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
  const request: {
    id: string
    method: string
    params: unknown
  } = JSON.parse(fakes.sendText.mock.calls[0]![0])
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
  await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledTimes(2))
  const capabilityRequest: {
    id: string
    method: string
    deviceToken: string
    params: { clientCapabilities?: string[] }
  } = JSON.parse(fakes.sendText.mock.calls[1]![0])
  return { session, confirmationRequest: request, capabilityRequest }
}

async function authenticateSession(capabilitySupported = true) {
  const { session, confirmationRequest, capabilityRequest } = await confirmResume()
  expect(session.getState()).toBe('handshaking')
  fakes.linkOptions!.onText(
    JSON.stringify(
      capabilitySupported
        ? {
            id: capabilityRequest.id,
            ok: true,
            result: capabilityRequest.params,
            _meta: { runtimeId: 'runtime-1' }
          }
        : {
            id: capabilityRequest.id,
            ok: false,
            error: { code: 'method_not_found', message: 'Unknown method' },
            _meta: { runtimeId: 'runtime-1' }
          }
    )
  )
  await vi.waitFor(() => expect(session.getState()).toBe('connected'))
  fakes.sendText.mockClear()
  return { session, confirmationRequest, capabilityRequest }
}

describe('mobile relay RPC session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakes.linkOptions = null
    fakes.sendText.mockReturnValue(true)
  })
  afterEach(() => vi.useRealTimers())

  it('releases stream listeners on failure even when close follows it', async () => {
    const { session } = await authenticateSession()
    const listener = vi.fn()
    session.subscribe('runtime.clientEvents.subscribe', {}, listener)
    await Promise.resolve()
    const request: { id: string } = JSON.parse(fakes.sendText.mock.calls[0]![0])
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

  it('requires exact resume observations and confirms by request ID before becoming connected', async () => {
    const { session, confirmationRequest, capabilityRequest } = await authenticateSession()

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
    const { session } = await authenticateSession(false)

    expect(session.getState()).toBe('connected')
    expect(session.getFailure()).toBeNull()
  })

  it('connects when the relay never answers capability negotiation', async () => {
    vi.useFakeTimers()
    const { session } = await confirmResume()
    expect(session.getState()).toBe('handshaking')

    await vi.advanceTimersByTimeAsync(1_000)

    expect(session.getState()).toBe('connected')
    expect(session.getFailure()).toBeNull()
    session.close()
  })

  // Dial stages distinguish a missing upgrade from slow cell assignment while both report connecting.
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
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
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
    const { session } = await authenticateSession()
    const terminalListener = vi.fn()
    session.subscribe('terminal.subscribe', { terminal: 'term-1' }, terminalListener)
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
    const terminalRequest: {
      id: string
    } = JSON.parse(fakes.sendText.mock.calls[0]![0])
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
    const browserRequest: { id: string } = JSON.parse(fakes.sendText.mock.calls[0]![0])
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
    const { session } = await authenticateSession()
    const pending = session.sendRequest('status.get')
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
    fakes.linkOptions!.onError(new Error('relay transport error'))

    await expect(pending).rejects.toThrow('relay transport error')
    await expect(pending.catch((error: unknown) => isRpcDeliveryUnknown(error))).resolves.toBe(true)
    expect(session.getState()).toBe('disconnected')
  })

  it('releases requests waiting on a failed session once it is retired, unsent', async () => {
    const { session } = await authenticateSession()
    fakes.linkOptions!.onError(new Error('relay lost'))
    vi.useFakeTimers()
    const settled = vi.fn()
    session.sendRequest('status.get').catch(settled)
    session.close()
    // No timer advances: the request must not sit out its connect timeout.
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce())

    expect(isRpcDeliveryUnknown(settled.mock.calls[0]![0])).toBe(false)
    expect(fakes.sendText).not.toHaveBeenCalled()
  })

  it('keeps a synchronous pre-write relay failure definite', async () => {
    const { session } = await authenticateSession()
    fakes.sendText.mockImplementationOnce(() => {
      fakes.linkOptions!.onError(new Error('relay outbound overflow'))
      return false
    })

    const error = await session
      .sendRequest('terminal.send', { terminal: 'term', text: 'hi' })
      .catch((cause: unknown) => cause)

    if (!(error instanceof Error)) {
      throw new Error('Expected the relay failure')
    }
    expect(error.message).toBe('relay outbound overflow')
    expect(isRpcDeliveryUnknown(error)).toBe(false)
  })

  it('marks in-flight requests delivery-unknown when the session closes', async () => {
    const { session } = await authenticateSession()
    const pending = session.sendRequest('terminal.send', { terminal: 'term', text: 'hi' })
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
    session.close()

    await expect(pending).rejects.toThrow('Client closed')
    await expect(pending.catch((error: unknown) => isRpcDeliveryUnknown(error))).resolves.toBe(true)
  })

  it('marks a relay RPC timeout delivery-unknown', async () => {
    const { session } = await authenticateSession()
    vi.useFakeTimers()
    try {
      const pending = session.sendRequest('terminal.send', { terminal: 'term', text: 'hi' })
      let settled = false
      const outcome = pending.then(
        (response) => {
          settled = true
          return response
        },
        (error: unknown) => {
          settled = true
          return error
        }
      )
      // Let sendRequest pass its connected-check microtask and register the timer.
      await vi.advanceTimersByTimeAsync(0)
      expect(fakes.sendText).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('"method":"terminal.send"')
      )
      await vi.advanceTimersByTimeAsync(999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const error = await outcome
      if (!(error instanceof Error)) {
        throw new Error('Expected the relay timeout')
      }
      expect(error.message).toBe('relay RPC timed out: terminal.send')
      expect(isRpcDeliveryUnknown(error)).toBe(true)
      session.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends requests and streams with no envelope byte for byte as before', async () => {
    const { session } = await authenticateSession()
    void session.sendRequest('status.get', { a: 1 })
    session.subscribe('terminal.subscribe', { terminal: 't1' }, () => undefined)
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledTimes(2))
    expect(
      fakes.sendText.mock.calls.map((call) => String(call[0]).replace(/"id":"[^"]+"/, ''))
    ).toEqual([
      '{,"method":"status.get","params":{"a":1},"deviceToken":"device-token"}',
      '{,"method":"terminal.subscribe","params":{"terminal":"t1"},"deviceToken":"device-token"}'
    ])
  })

  it('sends a server workspace call as the same top-level executionHost frame as before the envelope', async () => {
    const { session } = await authenticateSession()
    const server = scopeRpcClientToExecutionHost(session, 'runtime:a')
    void server.sendRequest('worktree.ps', { limit: 1 })
    server.subscribe('terminal.subscribe', { terminal: 't1' }, () => undefined)
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledTimes(2))
    const frames = fakes.sendText.mock.calls.map((call) => JSON.parse(String(call[0])))
    // Compare envelope routing independently of frame ids and JSON key order.
    expect(frames.map(({ id: _id, ...frame }) => frame)).toStrictEqual([
      {
        method: 'worktree.ps',
        params: { limit: 1 },
        executionHost: 'runtime:a',
        deviceToken: 'device-token'
      },
      {
        method: 'terminal.subscribe',
        params: { terminal: 't1' },
        executionHost: 'runtime:a',
        deviceToken: 'device-token'
      }
    ])
  })

  it('merges an envelope under the transport fields on requests, subscribes and unsubscribes', async () => {
    const { session } = await authenticateSession()
    const envelope = {
      executionHost: 'runtime:a',
      id: 'x',
      method: 'x',
      params: 'x',
      deviceToken: 'x'
    }
    void session.sendRequest('status.get', { a: 1 }, { envelope })
    const dispose = session.subscribe('terminal.subscribe', { terminal: 't1' }, () => undefined, {
      envelope
    })
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledTimes(2))
    dispose()
    const frames = fakes.sendText.mock.calls.map((call) => JSON.parse(String(call[0])))
    expect(frames).toEqual([
      expect.objectContaining({ method: 'status.get', params: { a: 1 } }),
      expect.objectContaining({ method: 'terminal.subscribe', params: { terminal: 't1' } }),
      expect.objectContaining({ method: 'terminal.unsubscribe' })
    ])
    for (const frame of frames) {
      expect(frame).toMatchObject({ executionHost: 'runtime:a', deviceToken: 'device-token' })
      expect(frame.id).not.toBe('x')
    }
  })
})
