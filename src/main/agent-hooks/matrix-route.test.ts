import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the matrix module surfaces the route calls. handleForPaneKey is
// deterministic-by-pane-key; sendToRoom/getStatus are stubbed per test.
type AskOutcome =
  | { answered: true; answer: string }
  | { answered: false; reason: 'timeout' | 'superseded' }

const sendToRoom =
  vi.fn<(body: string) => Promise<{ ok: boolean; eventId?: string; error?: string }>>()
const getStatus = vi.fn<() => Promise<{ enabled: boolean; roomId?: string }>>()
const registerAsk = vi.fn<(paneKey: string, timeoutMs: number) => Promise<AskOutcome>>()
const recordOutboundMessage = vi.fn<(eventId: string, paneKey: string) => void>()

vi.mock('../matrix/matrix-service', () => ({
  getMatrixService: () => ({ sendToRoom, getStatus })
}))
vi.mock('../matrix/session-handle-registry', () => ({
  handleForPaneKey: (paneKey: string) => `h-${paneKey}`
}))
vi.mock('../matrix/matrix-event-format', () => ({
  formatHandlePrefix: (handle: string, body: string) => `[orca ${handle}] ${body}`
}))
vi.mock('../matrix/outbound-message-session-registry', () => ({
  recordOutboundMessage: (eventId: string, paneKey: string) =>
    recordOutboundMessage(eventId, paneKey)
}))
vi.mock('../matrix/operator-ask-registry', () => ({
  registerAsk: (paneKey: string, timeoutMs: number) => registerAsk(paneKey, timeoutMs)
}))

import { tryHandleMatrixRoute } from './matrix-route'
import { AgentHookServer } from './server'

type FakeRes = {
  statusCode: number | null
  headers: Record<string, string> | null
  body: string | null
  writeHead: (status: number, headers?: Record<string, string>) => FakeRes
  end: (chunk?: string) => void
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers ?? null
      return res
    },
    end(chunk) {
      res.body = chunk ?? ''
    }
  }
  return res
}

beforeEach(() => {
  sendToRoom.mockReset()
  getStatus.mockReset()
  registerAsk.mockReset()
  recordOutboundMessage.mockReset()
})

describe('tryHandleMatrixRoute', () => {
  it('POST /matrix/send tags the message with the handle and returns it', async () => {
    sendToRoom.mockResolvedValue({ ok: true, eventId: '$sent' })
    const req = { method: 'POST', url: '/matrix/send' } as never
    const res = makeRes()

    const handled = await tryHandleMatrixRoute(req, res as never, '/matrix/send', {
      paneKey: 'pane-1',
      message: 'hello operator'
    })

    expect(handled).toBe(true)
    expect(sendToRoom).toHaveBeenCalledWith('[orca h-pane-1] hello operator')
    // The send's event id is tracked so an operator reply routes back to this pane.
    expect(recordOutboundMessage).toHaveBeenCalledWith('$sent', 'pane-1')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body ?? '{}')).toEqual({ ok: true, handle: 'h-pane-1' })
  })

  it('POST /matrix/send returns ok:false with the error when the send fails', async () => {
    sendToRoom.mockResolvedValue({ ok: false, error: 'client not running' })
    const req = { method: 'POST', url: '/matrix/send' } as never
    const res = makeRes()

    await tryHandleMatrixRoute(req, res as never, '/matrix/send', {
      paneKey: 'pane-1',
      message: 'hi'
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body ?? '{}')).toEqual({
      ok: false,
      handle: 'h-pane-1',
      error: 'client not running'
    })
  })

  it('POST /matrix/send rejects a missing message', async () => {
    const req = { method: 'POST', url: '/matrix/send' } as never
    const res = makeRes()

    await tryHandleMatrixRoute(req, res as never, '/matrix/send', { paneKey: 'pane-1' })

    expect(res.statusCode).toBe(400)
    expect(sendToRoom).not.toHaveBeenCalled()
  })

  it('GET /matrix/session-info returns handle, room id, and enabled', async () => {
    getStatus.mockResolvedValue({ enabled: true, roomId: '!room:server' })
    const req = { method: 'GET', url: '/matrix/session-info?paneKey=pane-9' } as never
    const res = makeRes()

    const handled = await tryHandleMatrixRoute(req, res as never, '/matrix/session-info', undefined)

    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body ?? '{}')).toEqual({
      handle: 'h-pane-9',
      roomId: '!room:server',
      enabled: true
    })
  })

  it('POST /matrix/ask sends the question, waits, and returns the answer', async () => {
    sendToRoom.mockResolvedValue({ ok: true, eventId: '$question' })
    registerAsk.mockResolvedValue({ answered: true, answer: 'go for it' })
    const req = { method: 'POST', url: '/matrix/ask' } as never
    const res = makeRes()

    const handled = await tryHandleMatrixRoute(req, res as never, '/matrix/ask', {
      paneKey: 'pane-1',
      question: 'proceed?',
      timeoutMs: 12_000
    })

    expect(handled).toBe(true)
    expect(sendToRoom).toHaveBeenCalledWith('[orca h-pane-1] proceed?')
    // The question's event id is recorded so a reply to it resolves this ask.
    expect(recordOutboundMessage).toHaveBeenCalledWith('$question', 'pane-1')
    expect(registerAsk).toHaveBeenCalledWith('pane-1', 12_000)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body ?? '{}')).toEqual({
      ok: true,
      answered: true,
      answer: 'go for it',
      handle: 'h-pane-1'
    })
  })

  it('POST /matrix/ask returns ok:true answered:false on timeout', async () => {
    sendToRoom.mockResolvedValue({ ok: true })
    registerAsk.mockResolvedValue({ answered: false, reason: 'timeout' })
    const req = { method: 'POST', url: '/matrix/ask' } as never
    const res = makeRes()

    await tryHandleMatrixRoute(req, res as never, '/matrix/ask', {
      paneKey: 'pane-1',
      question: 'proceed?'
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body ?? '{}')).toEqual({
      ok: true,
      answered: false,
      reason: 'timeout',
      handle: 'h-pane-1'
    })
  })

  it('POST /matrix/ask clamps the timeout to the floor', async () => {
    sendToRoom.mockResolvedValue({ ok: true })
    registerAsk.mockResolvedValue({ answered: false, reason: 'timeout' })
    const req = { method: 'POST', url: '/matrix/ask' } as never
    const res = makeRes()

    await tryHandleMatrixRoute(req, res as never, '/matrix/ask', {
      paneKey: 'pane-1',
      question: 'proceed?',
      timeoutMs: 10
    })

    expect(registerAsk).toHaveBeenCalledWith('pane-1', 5_000)
  })

  it('POST /matrix/ask reports a send failure without registering a waiter', async () => {
    sendToRoom.mockResolvedValue({ ok: false, error: 'client not running' })
    const req = { method: 'POST', url: '/matrix/ask' } as never
    const res = makeRes()

    await tryHandleMatrixRoute(req, res as never, '/matrix/ask', {
      paneKey: 'pane-1',
      question: 'proceed?'
    })

    expect(registerAsk).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body ?? '{}')).toEqual({
      ok: false,
      handle: 'h-pane-1',
      error: 'client not running'
    })
  })

  it('POST /matrix/ask rejects a missing question', async () => {
    const req = { method: 'POST', url: '/matrix/ask' } as never
    const res = makeRes()

    await tryHandleMatrixRoute(req, res as never, '/matrix/ask', { paneKey: 'pane-1' })

    expect(res.statusCode).toBe(400)
    expect(sendToRoom).not.toHaveBeenCalled()
    expect(registerAsk).not.toHaveBeenCalled()
  })

  it('returns false for an unrelated path so the caller falls through', async () => {
    const req = { method: 'POST', url: '/claude' } as never
    const res = makeRes()
    const handled = await tryHandleMatrixRoute(req, res as never, '/claude', {})
    expect(handled).toBe(false)
    expect(res.statusCode).toBeNull()
  })
})

describe('agent-hooks server Matrix routes (HTTP, token-authed)', () => {
  let server: AgentHookServer
  let port: string
  let token: string

  beforeEach(async () => {
    server = new AgentHookServer()
    await server.start()
    const env = server.buildPtyEnv()
    port = env.ORCA_AGENT_HOOK_PORT
    token = env.ORCA_AGENT_HOOK_TOKEN
  })

  afterEach(() => {
    server.stop()
  })

  it('POST /matrix/send with the right token reaches the matrix service', async () => {
    sendToRoom.mockResolvedValue({ ok: true })
    const response = await fetch(`http://127.0.0.1:${port}/matrix/send`, {
      method: 'POST',
      headers: { 'x-orca-agent-hook-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ paneKey: 'pane-7', message: 'ping' })
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, handle: 'h-pane-7' })
    expect(sendToRoom).toHaveBeenCalledWith('[orca h-pane-7] ping')
  })

  it('rejects /matrix/send without a token (403) and never calls the service', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/matrix/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paneKey: 'pane-7', message: 'ping' })
    })

    expect(response.status).toBe(403)
    expect(sendToRoom).not.toHaveBeenCalled()
  })

  it('rejects /matrix/send with a wrong token (403)', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/matrix/send`, {
      method: 'POST',
      headers: { 'x-orca-agent-hook-token': 'nope', 'content-type': 'application/json' },
      body: JSON.stringify({ paneKey: 'pane-7', message: 'ping' })
    })

    expect(response.status).toBe(403)
    expect(sendToRoom).not.toHaveBeenCalled()
  })
})
