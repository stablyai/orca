import { isRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, type RpcClient, type SendRequestOptions } from './rpc-client'

vi.mock('./direct-e2ee-framing-policy', () => import('./legacy-direct-framing-test-policy'))

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

vi.mock('./mobile-runtime-capability-negotiation', () => ({
  negotiateMobileRuntimeCapabilities: (args: { onReady: () => void }) => args.onReady()
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

const mockSockets: MockWebSocket[] = []
const originalWebSocket = globalThis.WebSocket

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

function terminalSendFrames(socket: MockWebSocket): string[] {
  return socket.sent.filter((frame) => frame.includes('terminal.send'))
}

describe('mobile rpc-client connect-wait replay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSockets.length = 0
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This socket fixture supplies the constructor, states, handlers, send and close consumed by the real client.
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  it('Given a cut connection When a send opts into failWhenDisconnected Then it rejects now and nothing replays after reconnect', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    socket.close()

    const request = client.sendRequest(
      'terminal.send',
      { terminal: 't1', text: 'YZZY' },
      { failWhenDisconnected: true }
    )
    const outcome = track(request)

    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(outcome.read()).toBe('Not connected: terminal.send')

      // Reconnect; the rejected keystroke must not ride the new socket.
      await vi.advanceTimersByTimeAsync(500)
      mockSockets[1]!.open()
      await vi.advanceTimersByTimeAsync(0)
      expect(client.getState()).toBe('connected')
      expect(terminalSendFrames(mockSockets[1]!)).toEqual([])
    } finally {
      client.close()
      await request.catch(() => undefined)
    }
  })

  it('Given a cut connection When a caller does not opt in Then the send parks and is delivered on the next socket', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    socket.close()

    // Pins the default behavior that motivates the opt-out: parked requests
    // replay after reconnect, which is what corrupted post-recovery input.
    const request = client.sendRequest('terminal.send', { terminal: 't1', text: 'YZZY' })
    const outcome = track(request)

    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(outcome.read()).toBe('pending')

      await vi.advanceTimersByTimeAsync(500)
      mockSockets[1]!.open()
      await vi.advanceTimersByTimeAsync(0)
      expect(terminalSendFrames(mockSockets[1]!)).toHaveLength(1)
      const frame: unknown = JSON.parse(
        terminalSendFrames(mockSockets[1]!)[0]!.replace(/^encrypted:/, '')
      )
      expect(frame).toEqual({
        id: expect.any(String),
        deviceToken: 'token',
        method: 'terminal.send',
        params: { terminal: 't1', text: 'YZZY' }
      })
      if (!frame || typeof frame !== 'object' || !('id' in frame) || typeof frame.id !== 'string') {
        throw new Error('Expected the written request ID')
      }
      mockSockets[1]!.receive(
        `encrypted:${JSON.stringify({ id: frame.id, ok: true, result: { sent: true } })}`
      )
      await expect(request).resolves.toMatchObject({ ok: true, result: { sent: true } })
    } finally {
      client.close()
      await request.catch(() => undefined)
    }
  })
})

// Exercise the hosted page's JSON boundary and the installed shell's real direct sender together.
import { harness } from '../mobile-web-shell/bridge-host-test-harness'
import { createPageClient } from '../mobile-web-shell/bridge/bridge-page-client-test-harness'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { withGitHubTargetOperation } from '../tasks/github-work-item-operation'
import { githubIssueUpdate } from '../tasks/mobile-task-item-state-operations'
import { GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY as exactCapability } from '../../../src/shared/source-control-runtime-capabilities'

const exactRepo = { owner: 'fork', repo: 'widgets', host: 'github.corp' }
function boundUpdate(client: RpcClient) {
  const params = { repo: 'id:clone', number: 93, updates: { state: 'closed' as const } }
  return withGitHubTargetOperation({
    client,
    params,
    ownerRepo: exactRepo,
    send: (selected, exact, options) =>
      githubIssueUpdate.request(selected, { ...params, ...exact }, options)
  }).then((reply) => githubIssueUpdate.interpret(reply))
}

// The fake is provider/network I/O only; page, JSON parser, host, logical scope and direct wait are production.
describe('hosted GitHub operation physical authority', () => {
  const clients: RpcClient[] = []
  beforeEach(() => {
    vi.useFakeTimers()
    mockSockets.length = 0
    vi.stubGlobal('WebSocket', MockWebSocket)
  })
  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close()
    }
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  function fixture() {
    const direct = connect('ws://desktop.invalid', 'token', 'server-key')
    clients.push(direct)
    let socket = mockSockets[0]!
    socket.open()
    let cutOnMutation = false
    const native = {
      ...createFakeRpcClient(),
      ...direct,
      // Methods on DirectRpcClient's prototype are bound by this facade.
      sendRequest: (method: string, params?: unknown, options?: SendRequestOptions) => {
        const pending = direct.sendRequest(method, params, options)
        if (cutOnMutation && method === 'github.updateIssue') {
          socket.close()
        }
        return pending
      },
      getState: () => direct.getState(),
      getGeneration: direct.getGeneration?.bind(direct),
      getLastConnectedAt: () => direct.getLastConnectedAt(),
      onStateChange: direct.onStateChange.bind(direct),
      close: () => direct.close()
    }
    const queued: string[] = []
    const page = createPageClient({ send: (json) => queued.push(json) })
    clients.push(page.client)
    let bridge = harness({
      client: native,
      ready: true,
      post: async (json) => {
        if (JSON.parse(json).type !== 'state') {
          page.deliverRaw(json)
        }
      }
    })
    function post() {
      const frames = queued.splice(0)
      for (const json of frames) {
        const parsed = JSON.parse(json)
        if (parsed.type !== 'ready') {
          bridge.host.receive(json)
        }
      }
    }
    const seen = new Set<string>()
    const effects: unknown[] = []
    function answer(runtime = 'a', capable = true) {
      for (const raw of socket.sent) {
        if (!raw.startsWith('encrypted:')) {
          continue
        }
        const request = JSON.parse(raw.replace(/^encrypted:/, ''))
        if (!request.id || seen.has(request.id)) {
          continue
        }
        seen.add(request.id)
        const wrong =
          request.expectedRuntimeSource && request.expectedRuntimeSource.runtimeId !== runtime
        if (request.method === 'github.updateIssue' && (!capable || !wrong)) {
          effects.push(request)
        }
        socket.receive(
          `encrypted:${JSON.stringify(
            request.method === 'status.get'
              ? {
                  id: request.id,
                  ok: true,
                  result: {
                    runtimeId: runtime,
                    hostDescriptor: { installationId: runtime },
                    capabilities: capable ? [exactCapability] : []
                  }
                }
              : wrong && capable
                ? {
                    id: request.id,
                    ok: false,
                    error: { code: 'runtime_source_mismatch', message: 'Open a new terminal' }
                  }
                : { id: request.id, ok: true, result: { ok: true } }
          )}`
        )
      }
    }
    const frames = () => socket.sent.filter((raw) => raw.includes('github.updateIssue'))
    return {
      page,
      get bridge() {
        return bridge
      },
      rebuild() {
        bridge.host.dispose()
        bridge = harness({
          client: native,
          ready: true,
          post: async (json) => {
            if (JSON.parse(json).type !== 'state') {
              page.deliverRaw(json)
            }
          }
        })
      },
      post,
      answer,
      frames,
      effects,
      cut: () => {
        cutOnMutation = true
      },
      get socket() {
        return socket
      },
      async reconnect() {
        socket.close()
        await vi.advanceTimersByTimeAsync(500)
        socket = mockSockets.at(-1)!
        socket.open()
        await vi.advanceTimersByTimeAsync(0)
      }
    }
  }
  async function turn() {
    await vi.advanceTimersByTimeAsync(0)
  }
  it.each([false, true])(
    'rechecks first-hop support at receipt; capable=%s replacement has zero provider effects',
    async (capable) => {
      const f = fixture()
      const result = boundUpdate(f.page.client)
      const rejected = expect(result).rejects.toThrow(
        capable ? 'connection changed' : 'Update Orca'
      )
      f.post()
      await turn()
      f.answer()
      await turn() // page obtains A, queues opted-in operation
      await f.reconnect()
      f.rebuild()
      f.post()
      await turn()
      f.answer('b', capable)
      await turn() // shell owns fresh B probe
      f.answer('b', capable)
      await rejected
      expect(f.effects).toEqual([])
      expect(f.frames()).toHaveLength(capable ? 1 : 0)
      const retry = boundUpdate(f.page.client)
      f.post()
      await turn()
      f.answer('b', true)
      await turn()
      f.post()
      await turn()
      f.answer('b', true)
      await turn()
      f.answer('b', true)
      await turn()
      await expect(retry).resolves.toMatchObject({ ok: true })
      expect(f.effects).toHaveLength(1)
      expect(f.effects[0]).toMatchObject({
        expectedRuntimeSource: { sourceId: 'b', runtimeId: 'b' }
      })
    }
  )
  it('stable A succeeds once; callback stays local and a definitive write reply survives later cutover', async () => {
    const f = fixture()
    const result = boundUpdate(f.page.client)
    f.post()
    await turn()
    f.answer()
    await turn()
    const operation = f.page
      .frames()
      .find((frame) => frame.type === 'request' && frame.method === 'github.updateIssue')
    expect(operation).not.toHaveProperty('options.beforeSend')
    f.post()
    await turn()
    f.answer()
    await turn()
    f.answer()
    await turn()
    f.socket.close()
    await expect(result).resolves.toMatchObject({ ok: true })
    expect(f.effects).toHaveLength(1)
    expect(f.effects[0]).toMatchObject({
      params: { ownerRepo: exactRepo },
      expectedRuntimeSource: { sourceId: 'a', runtimeId: 'a' }
    })
  })
  it('retires after connected-at-entry physical wait before mutation admission', async () => {
    const f = fixture()
    const result = boundUpdate(f.page.client)
    const rejected = expect(result).rejects.toThrow()
    f.post()
    await turn()
    f.answer()
    await turn()
    f.cut()
    f.post()
    await turn()
    f.answer()
    await turn()
    await rejected
    expect(f.frames()).toEqual([])
    expect(f.effects).toEqual([])
  })
  it('host disposal during preparation prevents a late probe from admitting an operation', async () => {
    const f = fixture()
    const result = boundUpdate(f.page.client)
    const rejected = expect(result).rejects.toThrow()
    f.post()
    await turn()
    f.answer()
    await turn()
    f.post()
    await turn()
    f.bridge.host.dispose()
    f.answer()
    await turn()
    f.page.client.close()
    await rejected
    expect(f.frames()).toEqual([])
  })
  it('freshly owns a same-runtime reconnect before receipt despite delayed page state', async () => {
    const f = fixture()
    const result = boundUpdate(f.page.client)
    f.post()
    await turn()
    f.answer()
    await turn()
    await f.reconnect()
    f.post()
    await turn()
    f.answer()
    await turn()
    f.answer()
    await turn()
    await expect(result).resolves.toMatchObject({ ok: true })
    expect(f.effects).toHaveLength(1)
    expect(f.frames()).toHaveLength(1)
  })
  it('keeps an admitted write with a lost reply delivery-unknown and never replays it on reconnect', async () => {
    const f = fixture()
    const result = boundUpdate(f.page.client)
    const outcome = result.catch((error: unknown) => error)
    f.post()
    await turn()
    f.answer()
    await turn()
    f.post()
    await turn()
    f.answer()
    await turn()
    expect(f.frames()).toHaveLength(1)
    await f.reconnect()
    await turn()
    // The error remains an unknown delivery from the bridge, not a claim that the write was unsent.
    expect(isRpcDeliveryUnknown(await outcome)).toBe(true)
    expect(f.frames()).toHaveLength(0)
    f.answer()
    await turn()
    expect(f.effects).toHaveLength(0)
  })
})
