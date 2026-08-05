import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserScreencastOpcode,
  encodeBrowserScreencastFrame
} from '../../../src/shared/browser-screencast-protocol'
import { encodeTerminalStreamFrame, TerminalStreamOpcode } from './terminal-stream-protocol'
import { verifyForceReconnectRpcHealth } from './force-reconnect-rpc-health'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import { isRpcDeliveryUnknown } from './rpc-delivery-ambiguity'

const fakes = vi.hoisted(() => ({
  linkOptions: null as null | {
    endpoint: { cellUrl: string; relayHostId: string }
    credential: string
    expectedCredentialKind: string
    onHello(value: unknown): void
    onAuthenticated(): void
    onText(value: string): void
    onBinary(value: Uint8Array): void
    onError(error: Error): void
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

async function authenticateSession() {
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
  const request = JSON.parse(fakes.sendText.mock.calls[0]![0] as string) as {
    id: string
    method: string
    params: unknown
  }
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
  await vi.waitFor(() => expect(session.getState()).toBe('connected'))
  fakes.sendText.mockClear()
  return { session, confirmationRequest: request }
}

describe('mobile relay RPC session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakes.linkOptions = null
    fakes.sendText.mockReturnValue(true)
  })

  it('requires exact resume observations and confirms by request ID before becoming connected', async () => {
    const { session, confirmationRequest } = await authenticateSession()

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
    expect(session.getAttachDeadlineAt()).toEqual(expect.any(Number))
  })

  it('does not send a strict Relay request after its budget is exhausted', async () => {
    const { session } = await authenticateSession()

    await expect(
      session.sendRequest('status.get', undefined, {
        timeoutMs: 0,
        budgetSpansConnect: true,
        strictDeadline: true
      })
    ).rejects.toThrow('relay RPC timed out: status.get')
    expect(fakes.sendText).not.toHaveBeenCalled()

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
    const { session } = await authenticateSession()
    const pending = session.sendRequest('status.get')
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
    fakes.linkOptions!.onError(new Error('relay transport error'))

    await expect(pending).rejects.toThrow('relay transport error')
    // The frame reached the wire, so the failure must read as delivery-unknown.
    await expect(pending.catch((error: unknown) => isRpcDeliveryUnknown(error))).resolves.toBe(true)
    expect(session.getState()).toBe('disconnected')
  })

  it('marks in-flight requests delivery-unknown when the session closes', async () => {
    const { session } = await authenticateSession()
    const pending = session.sendRequest('terminal.send', { terminal: 'term', text: 'hi' })
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
    session.close()

    await expect(pending).rejects.toThrow('Client closed')
    await expect(pending.catch((error: unknown) => isRpcDeliveryUnknown(error))).resolves.toBe(true)
  })

  it('probes before demoting a timed-out relay RPC', async () => {
    const { session } = await authenticateSession()
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
      expect(session.getState()).toBe('connected')
      expect(fakes.close).not.toHaveBeenCalled()
      expect(
        fakes.sendText.mock.calls.map(([payload]) => JSON.parse(payload as string)).at(-1)
      ).toMatchObject({ method: 'status.get' })

      await vi.advanceTimersByTimeAsync(8_000)
      expect(session.getFailure()).toMatchObject({ message: 'relay RPC timed out: status.get' })
      expect(session.getState()).toBe('disconnected')
      expect(fakes.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a relay session when its post-timeout probe answers', async () => {
    const { session } = await authenticateSession()
    vi.useFakeTimers()
    try {
      const request = session.sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
      const outcome = request.catch((error: unknown) => error)

      await vi.advanceTimersByTimeAsync(100)
      await expect(outcome).resolves.toMatchObject({
        message: 'relay RPC timed out: browser.screenshot'
      })
      const probe = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { id: string; method: string })
        .find(({ method }) => method === 'status.get')!
      fakes.linkOptions!.onText(
        JSON.stringify({ id: probe.id, ok: true, result: {}, _meta: { runtimeId: 'runtime-1' } })
      )

      await vi.advanceTimersByTimeAsync(8_000)
      expect(session.getState()).toBe('connected')
      expect(fakes.close).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps Relay application stalls latched through probes and recycles a repeated stall', async () => {
    const { session } = await authenticateSession()
    vi.useFakeTimers()
    try {
      const first = session
        .sendRequest('browser.screenshot', {}, { timeoutMs: 100, applicationHealthProbe: true })
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(100)
      await expect(first).resolves.toMatchObject({
        message: 'relay RPC timed out: browser.screenshot'
      })
      const probe = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { id: string; method: string })
        .find(({ method }) => method === 'status.get')!
      fakes.linkOptions!.onText(
        JSON.stringify({ id: probe.id, ok: true, result: {}, _meta: { runtimeId: 'runtime-1' } })
      )

      expect(session.getRpcUnresponsiveSince?.()).not.toBeNull()
      expect(session.getState()).toBe('connected')
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
      vi.useRealTimers()
    }
  })

  it('counts a late timed-out reply as relay control-plane liveness', async () => {
    const { session } = await authenticateSession()
    vi.useFakeTimers()
    try {
      const request = session.sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
      const outcome = request.catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(0)
      const timedOutRequest = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { id: string; method: string })
        .find(({ method }) => method === 'browser.screenshot')!

      await vi.advanceTimersByTimeAsync(100)
      await expect(outcome).resolves.toMatchObject({
        message: 'relay RPC timed out: browser.screenshot'
      })
      fakes.linkOptions!.onText(
        JSON.stringify({ id: timedOutRequest.id, ok: true, result: {}, _meta: {} })
      )

      await vi.advanceTimersByTimeAsync(16_500)
      expect(session.getState()).toBe('connected')
      expect(fakes.close).not.toHaveBeenCalled()
    } finally {
      session.close()
      vi.useRealTimers()
    }
  })

  it('counts a Relay subscription reply as control-plane liveness', async () => {
    const { session } = await authenticateSession()
    vi.useFakeTimers()
    try {
      session.subscribe('terminal.subscribe', { terminal: 'term-1' }, vi.fn())
      await vi.advanceTimersByTimeAsync(0)
      const subscribe = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { id: string; method: string })
        .find(({ method }) => method === 'terminal.subscribe')!

      session.notifyForeground()
      fakes.linkOptions!.onText(
        JSON.stringify({
          id: subscribe.id,
          ok: true,
          result: { type: 'subscribed', streamId: 42 },
          _meta: {}
        })
      )
      await vi.advanceTimersByTimeAsync(8_000)

      expect(session.getState()).toBe('connected')
      expect(fakes.close).not.toHaveBeenCalled()
    } finally {
      session.close()
      vi.useRealTimers()
    }
  })

  it.each([
    ['lease-only terminal', { type: 'subscribed', streamId: null }],
    ['native-chat snapshot', { type: 'snapshot' }],
    ['session-tabs snapshot', { type: 'snapshot' }]
  ])('counts a Relay %s reply as control-plane liveness', async (_name, result) => {
    const { session } = await authenticateSession()
    vi.useFakeTimers()
    try {
      session.subscribe('nativeChat.subscribe', {}, vi.fn())
      await vi.advanceTimersByTimeAsync(0)
      const subscribe = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { id: string; method: string })
        .find(({ method }) => method === 'nativeChat.subscribe')!

      session.notifyForeground()
      fakes.linkOptions!.onText(
        JSON.stringify({ id: subscribe.id, ok: true, streaming: true, result, _meta: {} })
      )
      await vi.advanceTimersByTimeAsync(8_000)

      expect(session.getState()).toBe('connected')
      expect(fakes.close).not.toHaveBeenCalled()
    } finally {
      session.close()
      vi.useRealTimers()
    }
  })

  it('does not count repeated Relay subscription frames as fresh control responses', async () => {
    const { session } = await authenticateSession()
    vi.useFakeTimers()
    try {
      session.subscribe('nativeChat.subscribe', {}, vi.fn())
      await vi.advanceTimersByTimeAsync(0)
      const subscribe = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { id: string; method: string })
        .find(({ method }) => method === 'nativeChat.subscribe')!
      const response = JSON.stringify({
        id: subscribe.id,
        ok: true,
        streaming: true,
        result: { type: 'snapshot' },
        _meta: {}
      })
      fakes.linkOptions!.onText(response)

      session.notifyForeground()
      fakes.linkOptions!.onText(response)
      // Why: the repeated frame buys bounded congestion grace, never satisfaction.
      await vi.advanceTimersByTimeAsync(8_000)
      expect(session.getState()).toBe('connected')
      await vi.advanceTimersByTimeAsync(8_000)

      expect(session.getState()).toBe('disconnected')
      expect(fakes.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let Relay terminal payload traffic mask a stalled control channel', async () => {
    const { session } = await authenticateSession()
    vi.useFakeTimers()
    try {
      session.subscribe('terminal.subscribe', { terminal: 'term-1' }, vi.fn())
      await vi.advanceTimersByTimeAsync(0)
      const subscribe = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { id: string; method: string })
        .find(({ method }) => method === 'terminal.subscribe')!
      fakes.linkOptions!.onText(
        JSON.stringify({
          id: subscribe.id,
          ok: true,
          result: { type: 'subscribed', streamId: 42 },
          _meta: {}
        })
      )

      session.notifyForeground()
      // Why: continuous terminal traffic in every probe window is the exact
      // #10385 shape — it may only defer failure through the bounded grace.
      for (let seq = 1; seq <= 3; seq += 1) {
        fakes.linkOptions!.onBinary(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Output,
            streamId: 42,
            seq,
            payload: new TextEncoder().encode('still alive')
          })
        )
        if (seq < 3) {
          await vi.advanceTimersByTimeAsync(8_000)
          expect(session.getState()).toBe('connected')
        }
      }
      await vi.advanceTimersByTimeAsync(8_000)

      expect(session.getState()).toBe('disconnected')
      expect(fakes.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a congested Relay session when a late control reply lands during the grace window', async () => {
    const { session } = await authenticateSession()
    vi.useFakeTimers()
    try {
      session.subscribe('terminal.subscribe', { terminal: 'term-1' }, vi.fn())
      await vi.advanceTimersByTimeAsync(0)
      const subscribe = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { id: string; method: string })
        .find(({ method }) => method === 'terminal.subscribe')!
      fakes.linkOptions!.onText(
        JSON.stringify({
          id: subscribe.id,
          ok: true,
          result: { type: 'subscribed', streamId: 42 },
          _meta: {}
        })
      )

      session.notifyForeground()
      await vi.advanceTimersByTimeAsync(0)
      const probe = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { id: string; method: string })
        .findLast(({ method }) => method === 'status.get')!
      fakes.linkOptions!.onBinary(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Output,
          streamId: 42,
          seq: 1,
          payload: new TextEncoder().encode('backlog')
        })
      )
      await vi.advanceTimersByTimeAsync(8_000)
      expect(session.getState()).toBe('connected')

      // Why: the parked probe reply finally drains behind the terminal backlog —
      // a real control response ends the grace chain instead of a session failure.
      fakes.linkOptions!.onText(JSON.stringify({ id: probe.id, ok: true, result: {}, _meta: {} }))
      await vi.advanceTimersByTimeAsync(8_000)

      expect(session.getState()).toBe('connected')
      expect(fakes.close).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('periodically demotes a silent half-open Relay session', async () => {
    vi.useFakeTimers()
    try {
      const { session } = await authenticateSession()

      await vi.advanceTimersByTimeAsync(20_000)
      expect(
        fakes.sendText.mock.calls.map(([payload]) => JSON.parse(payload as string)).at(-1)
      ).toMatchObject({ method: 'status.get' })
      expect(session.getState()).toBe('connected')

      await vi.advanceTimersByTimeAsync(8_000)
      expect(session.getState()).toBe('disconnected')
      expect(fakes.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops periodic Relay probing when the session closes', async () => {
    vi.useFakeTimers()
    try {
      const { session } = await authenticateSession()
      session.close()

      await vi.advanceTimersByTimeAsync(20_000)
      expect(fakes.sendText).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks a Relay session auth-failed when its periodic probe is unauthorized', async () => {
    vi.useFakeTimers()
    try {
      const { session } = await authenticateSession()

      await vi.advanceTimersByTimeAsync(20_000)
      const probe = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { id: string; method: string })
        .findLast(({ method }) => method === 'status.get')!
      fakes.linkOptions!.onText(
        JSON.stringify({
          id: probe.id,
          ok: false,
          error: { code: 'unauthorized', message: 'Invalid device token' },
          _meta: {}
        })
      )

      expect(session.getFailure()).toBeInstanceOf(MobileE2EEAuthenticationError)
      expect(session.getState()).toBe('auth-failed')
      expect(fakes.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects Force Reconnect health when Relay authorization was revoked', async () => {
    const { session } = await authenticateSession()
    const verification = verifyForceReconnectRpcHealth(session)
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledOnce())
    const probe = JSON.parse(fakes.sendText.mock.calls[0]![0] as string) as { id: string }
    fakes.linkOptions!.onText(
      JSON.stringify({
        id: probe.id,
        ok: false,
        error: { code: 'unauthorized', message: 'Invalid device token' },
        _meta: {}
      })
    )

    await expect(verification).rejects.toBeInstanceOf(MobileE2EEAuthenticationError)
    expect(session.getState()).toBe('auth-failed')
  })

  it('keeps concurrent written RPCs delivery-ambiguous when one request is unauthorized', async () => {
    const { session } = await authenticateSession()
    const rejected = session.sendRequest('status.get').catch((error: unknown) => error)
    const concurrent = session
      .sendRequest('terminal.send', { terminal: 'term', text: 'hi' })
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(fakes.sendText).toHaveBeenCalledTimes(2))
    const requests = fakes.sendText.mock.calls.map(
      ([payload]) => JSON.parse(payload as string) as { id: string; method: string }
    )
    const rejectedRequest = requests.find(({ method }) => method === 'status.get')!

    fakes.linkOptions!.onText(
      JSON.stringify({
        id: rejectedRequest.id,
        ok: false,
        error: { code: 'unauthorized', message: 'Invalid device token' },
        _meta: {}
      })
    )

    await expect(rejected).resolves.toBeInstanceOf(MobileE2EEAuthenticationError)
    await expect(rejected.then(isRpcDeliveryUnknown)).resolves.toBe(false)
    await expect(concurrent.then(isRpcDeliveryUnknown)).resolves.toBe(true)
    expect(session.getState()).toBe('auth-failed')
  })

  it('keeps a Relay session when a fresh timeout probe proves it live', async () => {
    const { session } = await authenticateSession()
    vi.useFakeTimers()
    try {
      const stalled = session.sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
      const stalledOutcome = stalled.catch((error: unknown) => error)
      const healthy = session.sendRequest('status.get', undefined, { timeoutMs: 100 })
      await vi.advanceTimersByTimeAsync(0)
      const requests = fakes.sendText.mock.calls.map(
        ([payload]) => JSON.parse(payload as string) as { id: string; method: string }
      )
      const healthRequest = requests.find(({ method }) => method === 'status.get')!
      fakes.linkOptions!.onText(
        JSON.stringify({ id: healthRequest.id, ok: true, result: {}, _meta: {} })
      )

      await expect(healthy).resolves.toMatchObject({ ok: true })
      await vi.advanceTimersByTimeAsync(100)
      await expect(stalledOutcome).resolves.toMatchObject({
        message: 'relay RPC timed out: browser.screenshot'
      })
      const probeRequest = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { id: string; method: string })
        .findLast(({ id, method }) => method === 'status.get' && id !== healthRequest.id)!
      fakes.linkOptions!.onText(
        JSON.stringify({ id: probeRequest.id, ok: true, result: {}, _meta: {} })
      )
      // Why: run out the probe deadline — without the reply above, the probe
      // would demote the session inside this window, so the advance is what
      // makes the "proves it live" claim falsifiable.
      await vi.advanceTimersByTimeAsync(8_000)
      expect(session.getState()).toBe('connected')
      expect(fakes.close).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('demotes Relay when an earlier response precedes a later control-plane stall', async () => {
    const { session } = await authenticateSession()
    vi.useFakeTimers()
    try {
      const stalled = session.sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
      const stalledOutcome = stalled.catch((error: unknown) => error)
      const healthy = session.sendRequest('status.get', undefined, { timeoutMs: 100 })
      await vi.advanceTimersByTimeAsync(0)
      const healthRequest = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { id: string; method: string })
        .find(({ method }) => method === 'status.get')!
      fakes.linkOptions!.onText(
        JSON.stringify({ id: healthRequest.id, ok: true, result: {}, _meta: {} })
      )

      await expect(healthy).resolves.toMatchObject({ ok: true })
      await vi.advanceTimersByTimeAsync(100)
      await expect(stalledOutcome).resolves.toMatchObject({
        message: 'relay RPC timed out: browser.screenshot'
      })
      expect(session.getState()).toBe('connected')

      await vi.advanceTimersByTimeAsync(8_000)
      expect(session.getFailure()).toMatchObject({
        message: 'relay RPC timed out: status.get'
      })
      expect(session.getState()).toBe('disconnected')
      expect(fakes.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('queues a fresh Relay timeout probe behind an older in-flight probe', async () => {
    const { session } = await authenticateSession()
    vi.useFakeTimers()
    try {
      session.notifyForeground()
      const stalled = session.sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
      const stalledOutcome = stalled.catch((error: unknown) => error)
      const healthy = session.sendRequest('speech.models.list', {}, { timeoutMs: 100 })
      await vi.advanceTimersByTimeAsync(0)
      const healthyRequest = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { id: string; method: string })
        .find(({ method }) => method === 'speech.models.list')!
      fakes.linkOptions!.onText(
        JSON.stringify({ id: healthyRequest.id, ok: true, result: {}, _meta: {} })
      )

      await expect(healthy).resolves.toMatchObject({ ok: true })
      await vi.advanceTimersByTimeAsync(100)
      await expect(stalledOutcome).resolves.toMatchObject({
        message: 'relay RPC timed out: browser.screenshot'
      })
      await vi.advanceTimersByTimeAsync(7_900)
      const probes = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { method: string })
        .filter(({ method }) => method === 'status.get')
      expect(probes).toHaveLength(2)
      expect(session.getState()).toBe('connected')

      await vi.advanceTimersByTimeAsync(8_000)
      expect(session.getState()).toBe('disconnected')
      expect(fakes.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps late Relay request evidence across a queued probe handoff', async () => {
    const { session } = await authenticateSession()
    vi.useFakeTimers()
    try {
      session.notifyForeground()
      const stalled = session.sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
      const stalledOutcome = stalled.catch((error: unknown) => error)
      const healthy = session.sendRequest('speech.models.list', {}, { timeoutMs: 100 })
      await vi.advanceTimersByTimeAsync(0)
      const requests = fakes.sendText.mock.calls.map(
        ([payload]) => JSON.parse(payload as string) as { id: string; method: string }
      )
      const stalledRequest = requests.find(({ method }) => method === 'browser.screenshot')!
      const healthyRequest = requests.find(({ method }) => method === 'speech.models.list')!
      fakes.linkOptions!.onText(
        JSON.stringify({ id: healthyRequest.id, ok: true, result: {}, _meta: {} })
      )

      await expect(healthy).resolves.toMatchObject({ ok: true })
      await vi.advanceTimersByTimeAsync(100)
      await expect(stalledOutcome).resolves.toMatchObject({
        message: 'relay RPC timed out: browser.screenshot'
      })
      await vi.advanceTimersByTimeAsync(7_900)
      const probes = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { method: string })
        .filter(({ method }) => method === 'status.get')
      expect(probes).toHaveLength(2)
      fakes.linkOptions!.onText(
        JSON.stringify({ id: stalledRequest.id, ok: true, result: {}, _meta: {} })
      )

      await vi.advanceTimersByTimeAsync(8_000)
      expect(
        fakes.sendText.mock.calls
          .map(([payload]) => JSON.parse(payload as string) as { method: string })
          .filter(({ method }) => method === 'status.get')
      ).toHaveLength(2)
      expect(session.getState()).toBe('connected')
      expect(fakes.close).not.toHaveBeenCalled()
    } finally {
      session.close()
      vi.useRealTimers()
    }
  })

  it('retains late Relay reply evidence after an earlier probe completes', async () => {
    const { session } = await authenticateSession()
    vi.useFakeTimers()
    try {
      const request = session.sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
      const outcome = request.catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(0)
      const timedOutRequest = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { id: string; method: string })
        .find(({ method }) => method === 'browser.screenshot')!

      await vi.advanceTimersByTimeAsync(100)
      await expect(outcome).resolves.toMatchObject({
        message: 'relay RPC timed out: browser.screenshot'
      })
      const firstProbe = fakes.sendText.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { id: string; method: string })
        .find(({ method }) => method === 'status.get')!
      fakes.linkOptions!.onText(
        JSON.stringify({ id: firstProbe.id, ok: true, result: {}, _meta: {} })
      )
      await vi.advanceTimersByTimeAsync(0)

      session.notifyForeground()
      fakes.linkOptions!.onText(
        JSON.stringify({ id: timedOutRequest.id, ok: true, result: {}, _meta: {} })
      )
      await vi.advanceTimersByTimeAsync(16_500)

      expect(session.getState()).toBe('connected')
      expect(fakes.close).not.toHaveBeenCalled()
    } finally {
      session.close()
      vi.useRealTimers()
    }
  })
})
