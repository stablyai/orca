import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'
import { verifyForceReconnectRpcHealth } from './force-reconnect-rpc-health'

vi.mock('./e2ee', () => ({
  generateKeyPair: () => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(32)
  }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-public-key',
  encrypt: (plaintext: string) => `encrypted:${plaintext}`,
  decrypt: (raw: string) => raw.replace(/^encrypted:/, ''),
  decryptBytes: (bytes: Uint8Array) => bytes
}))

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3

  readonly CONNECTING = MockWebSocket.CONNECTING
  readonly OPEN = MockWebSocket.OPEN
  readonly CLOSED = MockWebSocket.CLOSED

  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  sent: string[] = []
  close = vi.fn(() => {
    if (this.readyState === MockWebSocket.CLOSED) {
      return
    }
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  })

  constructor(readonly endpoint: string) {
    mockSockets.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
    this.receive(JSON.stringify({ type: 'e2ee_ready' }))
    this.receive('encrypted:{"type":"e2ee_authenticated"}')
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: payload })
  }
}

function sentRequest(socket: MockWebSocket, method: string): { id: string } {
  const payload = socket.sent.find((value) => value.includes(`"method":"${method}"`))
  if (!payload) {
    throw new Error(`No ${method} request sent`)
  }
  return JSON.parse(payload.replace(/^encrypted:/, '')) as { id: string }
}

function sentRequests(socket: MockWebSocket, method: string): { id: string }[] {
  return socket.sent
    .filter((value) => value.includes(`"method":"${method}"`))
    .map((payload) => JSON.parse(payload.replace(/^encrypted:/, '')) as { id: string })
}

const mockSockets: MockWebSocket[] = []
const originalWebSocket = globalThis.WebSocket

/** Latest settled state of a request, so a timeout can be observed without
 *  awaiting a promise that would reject under fake timers. */
function track(request: Promise<unknown>): { read: () => string } {
  let outcome = 'pending'
  request.then(
    () => {
      outcome = 'resolved'
    },
    (error: Error) => {
      outcome = error.message
    }
  )
  return { read: () => outcome }
}

describe('mobile rpc-client request deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSockets.length = 0
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  it('does not send a strict request after its budget is exhausted', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()

    await expect(
      client.sendRequest('status.get', undefined, {
        timeoutMs: 0,
        budgetSpansConnect: true,
        strictDeadline: true
      })
    ).rejects.toThrow('Request timed out: status.get')
    expect(sentRequests(socket, 'status.get')).toEqual([])

    client.close()
  })

  it('spends one deadline across connect-wait and request, not one each', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    socket.close()

    const request = client.sendRequest(
      'terminal.send',
      { terminal: 't1', text: 'hi' },
      { timeoutMs: 5_000, budgetSpansConnect: true }
    )
    const outcome = track(request)

    try {
      // The first reconnect delay burns 500ms of the caller's 5s budget.
      await vi.advanceTimersByTimeAsync(500)
      mockSockets[1]!.open()
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(4_499)
      expect(outcome.read()).toBe('pending')

      // Restarting the budget after connecting would still have 500ms to go here.
      await vi.advanceTimersByTimeAsync(1)
      expect(outcome.read()).toBe('Request timed out: terminal.send')
    } finally {
      client.close()
      await request.catch(() => undefined)
    }
  })

  it('leaves a caller that did not opt in on the post-connect clock', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    socket.close()

    // A pre-existing caller's budget was sized against the request phase alone;
    // the connect wait must not eat into it.
    const request = client.sendRequest(
      'speech.dictation.finish',
      { dictationId: 'd1' },
      { timeoutMs: 5_000 }
    )
    const outcome = track(request)

    try {
      await vi.advanceTimersByTimeAsync(500)
      mockSockets[1]!.open()
      await vi.advanceTimersByTimeAsync(0)

      // A shared deadline would already have fired at 4_500 here.
      await vi.advanceTimersByTimeAsync(4_999)
      expect(outcome.read()).toBe('pending')

      await vi.advanceTimersByTimeAsync(1)
      expect(outcome.read()).toBe('Request timed out: speech.dictation.finish')
    } finally {
      client.close()
      await request.catch(() => undefined)
    }
  })

  it('never floors a sub-second request timeout above what the caller asked for', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    mockSockets[0]!.open()

    // Under the 1s minimum: the floor clamps to 400ms rather than stretching it.
    const request = client.sendRequest(
      'terminal.send',
      { terminal: 't1', text: 'hi' },
      { timeoutMs: 400, budgetSpansConnect: true }
    )
    const outcome = track(request)

    try {
      await vi.advanceTimersByTimeAsync(399)
      expect(outcome.read()).toBe('pending')
      await vi.advanceTimersByTimeAsync(1)
      expect(outcome.read()).toBe('Request timed out: terminal.send')
    } finally {
      client.close()
      await request.catch(() => undefined)
    }
  })

  it('probes before demoting a request that exceeds its deadline', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    const request = client.sendRequest('speech.dictation.finish', {}, { timeoutMs: 123 })
    const outcome = track(request)

    await vi.advanceTimersByTimeAsync(123)
    expect(outcome.read()).toBe('Request timed out: speech.dictation.finish')
    const probe = sentRequest(socket, 'status.get')
    expect(socket.close).not.toHaveBeenCalled()
    expect(client.getState()).toBe('connected')

    socket.receive(`encrypted:${JSON.stringify({ id: probe.id, ok: true, result: {} })}`)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(socket.close).not.toHaveBeenCalled()
    expect(client.getState()).toBe('connected')

    client.close()
    await request.catch(() => undefined)
  })

  it('counts a late timed-out reply as control-plane liveness', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    const request = client.sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
    const outcome = track(request)
    await vi.advanceTimersByTimeAsync(0)
    const timedOutRequest = sentRequest(socket, 'browser.screenshot')

    await vi.advanceTimersByTimeAsync(100)
    expect(outcome.read()).toBe('Request timed out: browser.screenshot')
    expect(sentRequest(socket, 'status.get')).toBeDefined()
    socket.receive(`encrypted:${JSON.stringify({ id: timedOutRequest.id, ok: true, result: {} })}`)

    await vi.advanceTimersByTimeAsync(16_500)
    expect(socket.close).not.toHaveBeenCalled()
    expect(client.getState()).toBe('connected')

    client.close()
    await request.catch(() => undefined)
  })

  it('retains late reply evidence after an earlier probe completes', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    const request = client.sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
    const outcome = track(request)
    await vi.advanceTimersByTimeAsync(0)
    const timedOutRequest = sentRequest(socket, 'browser.screenshot')

    await vi.advanceTimersByTimeAsync(100)
    expect(outcome.read()).toBe('Request timed out: browser.screenshot')
    const firstProbe = sentRequest(socket, 'status.get')
    socket.receive(`encrypted:${JSON.stringify({ id: firstProbe.id, ok: true, result: {} })}`)
    await vi.advanceTimersByTimeAsync(0)

    client.notifyForeground()
    socket.receive(`encrypted:${JSON.stringify({ id: timedOutRequest.id, ok: true, result: {} })}`)
    await vi.advanceTimersByTimeAsync(16_500)

    expect(socket.close).not.toHaveBeenCalled()
    expect(client.getState()).toBe('connected')
    client.close()
    await request.catch(() => undefined)
  })

  it('demotes when the post-timeout control probe also stalls', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    const request = client.sendRequest('browser.screenshot', {}, { timeoutMs: 123 })
    const outcome = track(request)

    await vi.advanceTimersByTimeAsync(123)
    expect(outcome.read()).toBe('Request timed out: browser.screenshot')
    expect(sentRequest(socket, 'status.get')).toBeDefined()
    expect(client.getState()).toBe('connected')

    await vi.advanceTimersByTimeAsync(8_000)
    expect(socket.close).toHaveBeenCalled()
    expect(client.getState()).toBe('reconnecting')

    client.close()
    await request.catch(() => undefined)
  })

  it('keeps the socket when a fresh post-timeout probe proves it live', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    const stalled = client.sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
    const stalledOutcome = stalled.catch((error: unknown) => error)
    const healthy = client.sendRequest('status.get', undefined, { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(0)
    const healthRequest = sentRequest(socket, 'status.get')
    socket.receive(`encrypted:${JSON.stringify({ id: healthRequest.id, ok: true, result: {} })}`)

    await expect(healthy).resolves.toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(100)
    await expect(stalledOutcome).resolves.toMatchObject({
      message: 'Request timed out: browser.screenshot'
    })
    const freshProbe = sentRequests(socket, 'status.get').find(({ id }) => id !== healthRequest.id)!
    socket.receive(`encrypted:${JSON.stringify({ id: freshProbe.id, ok: true, result: {} })}`)
    await vi.advanceTimersByTimeAsync(8_000)
    expect(socket.close).not.toHaveBeenCalled()
    expect(client.getState()).toBe('connected')

    client.close()
  })

  it('demotes when an earlier response precedes a later control-plane stall', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    const stalled = client.sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
    const stalledOutcome = stalled.catch((error: unknown) => error)
    const healthy = client.sendRequest('status.get', undefined, { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(0)
    const healthRequest = sentRequest(socket, 'status.get')
    socket.receive(`encrypted:${JSON.stringify({ id: healthRequest.id, ok: true, result: {} })}`)

    await expect(healthy).resolves.toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(100)
    await expect(stalledOutcome).resolves.toMatchObject({
      message: 'Request timed out: browser.screenshot'
    })
    expect(sentRequests(socket, 'status.get')).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(8_000)
    expect(socket.close).toHaveBeenCalled()
    expect(client.getState()).toBe('reconnecting')

    client.close()
  })

  it('queues a fresh timeout probe behind an older in-flight probe', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    client.notifyForeground()
    const stalled = client.sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
    const stalledOutcome = stalled.catch((error: unknown) => error)
    const healthy = client.sendRequest('speech.models.list', {}, { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(0)
    const healthyRequest = sentRequest(socket, 'speech.models.list')
    socket.receive(`encrypted:${JSON.stringify({ id: healthyRequest.id, ok: true, result: {} })}`)

    await expect(healthy).resolves.toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(100)
    await expect(stalledOutcome).resolves.toMatchObject({
      message: 'Request timed out: browser.screenshot'
    })
    await vi.advanceTimersByTimeAsync(7_900)
    expect(sentRequests(socket, 'status.get')).toHaveLength(2)
    expect(client.getState()).toBe('connected')

    await vi.advanceTimersByTimeAsync(8_000)
    expect(client.getState()).toBe('reconnecting')
    expect(socket.close).toHaveBeenCalled()
    client.close()
  })

  it('keeps late request evidence across a queued probe handoff', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    client.notifyForeground()
    const stalled = client.sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
    const stalledOutcome = stalled.catch((error: unknown) => error)
    const healthy = client.sendRequest('speech.models.list', {}, { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(0)
    const stalledRequest = sentRequest(socket, 'browser.screenshot')
    const healthyRequest = sentRequest(socket, 'speech.models.list')
    socket.receive(`encrypted:${JSON.stringify({ id: healthyRequest.id, ok: true, result: {} })}`)

    await expect(healthy).resolves.toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(100)
    await expect(stalledOutcome).resolves.toMatchObject({
      message: 'Request timed out: browser.screenshot'
    })
    await vi.advanceTimersByTimeAsync(7_900)
    expect(sentRequests(socket, 'status.get')).toHaveLength(2)
    socket.receive(`encrypted:${JSON.stringify({ id: stalledRequest.id, ok: true, result: {} })}`)

    await vi.advanceTimersByTimeAsync(16_500)
    expect(client.getState()).toBe('connected')
    expect(socket.close).not.toHaveBeenCalled()
    client.close()
  })

  it('keeps late activity-probe evidence across a queued probe handoff', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    client.notifyForeground()
    const firstProbe = sentRequest(socket, 'status.get')
    const stalled = client.sendRequest('browser.screenshot', {}, { timeoutMs: 100 })
    const stalledOutcome = stalled.catch((error: unknown) => error)
    const healthy = client.sendRequest('speech.models.list', {}, { timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(0)
    const healthyRequest = sentRequest(socket, 'speech.models.list')
    socket.receive(`encrypted:${JSON.stringify({ id: healthyRequest.id, ok: true, result: {} })}`)

    await expect(healthy).resolves.toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(100)
    await expect(stalledOutcome).resolves.toMatchObject({
      message: 'Request timed out: browser.screenshot'
    })
    await vi.advanceTimersByTimeAsync(7_900)
    expect(sentRequests(socket, 'status.get')).toHaveLength(2)
    socket.receive(`encrypted:${JSON.stringify({ id: firstProbe.id, ok: true, result: {} })}`)

    await vi.advanceTimersByTimeAsync(16_500)
    expect(client.getState()).toBe('connected')
    expect(socket.close).not.toHaveBeenCalled()
    client.close()
  })

  it('keeps Force Reconnect inside its deadline after a late connection', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const verification = verifyForceReconnectRpcHealth(client)
    let outcome = 'pending'
    const settled = verification.catch((error: Error) => {
      outcome = error.message
    })

    await vi.advanceTimersByTimeAsync(14_900)
    mockSockets.at(-1)!.open()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(99)
    expect(outcome).toBe('pending')

    await vi.advanceTimersByTimeAsync(1)
    await settled
    expect(outcome).toBe('Request timed out: worktree.ps')

    client.close()
  })
})
