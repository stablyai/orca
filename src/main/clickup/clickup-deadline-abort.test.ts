import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
const saveToken = vi.fn(async () => undefined)
const ensureProxy = vi.fn<() => Promise<undefined>>()

vi.mock('../network/http-client', () => ({
  getMainHttpClient: () => ({ proxySession: () => null, fetch: fetchMock })
}))
vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: ensureProxy
}))
vi.mock('../observability/tracer', () => ({
  withSpan: (_name: string, run: (span: { addEvent: () => void }) => unknown) =>
    run({ addEvent: () => undefined })
}))
vi.mock('./clickup-account-store', () => ({
  getAccountState: async () => ({
    version: 1,
    viewer: { id: '1', username: 'u', email: 'u@example.com' },
    workspaces: [],
    selectedWorkspaceId: '9001'
  }),
  readToken: async () => 'token',
  getCredentialError: async () => undefined,
  getTokenProtection: async () => null,
  inAccountOrder: async (run: () => Promise<unknown>) => run(),
  saveToken,
  deleteToken: async () => undefined,
  writeAccountState: async () => undefined
}))

const OPERATION_DEADLINE_MS = 25_000
const REQUEST_DEADLINE_MS = 20_000

function abortableFetch(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () =>
      reject(new DOMException('This operation was aborted', 'AbortError'))
    )
  })
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

/** Elapses on the fake clock installed in beforeEach; the test advances it explicitly. */
function fakeClockDelay(ms: number): Promise<void> {
  // ast-grep-ignore: test-no-real-time-wait -- runs only under vi.useFakeTimers(), never the wall clock
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function loadClient() {
  const [client, request] = await Promise.all([
    import('./client'),
    import('./authenticated-request')
  ])
  return { ...client, clickupRequest: request.clickupRequest }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  fetchMock.mockReset()
  saveToken.mockClear()
  ensureProxy.mockReset()
  ensureProxy.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('operation deadline', () => {
  it('maps the deadline firing while a request waits for a slot to a timeout', async () => {
    const { withClickUpContext, clickupRequest } = await loadClient()
    // Four requests that never settle hold every slot.
    fetchMock.mockImplementation(() => new Promise(() => undefined))
    for (let held = 0; held < 4; held++) {
      void clickupRequest('token', '/held')
    }
    const outcome = withClickUpContext(async (context) => {
      await fakeClockDelay(6_000)
      return clickupRequest('token', '/queued', { signal: context.signal })
    })
    const assertion = expect(outcome).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(OPERATION_DEADLINE_MS)
    await assertion
  })

  it('releases the request slot when proxy setup stalls past the request deadline', async () => {
    const { clickupRequest } = await loadClient()
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }))
    const stalled = Array.from({ length: 4 }, () => {
      ensureProxy.mockImplementationOnce(() => new Promise(() => undefined))
      return clickupRequest('token', '/stalled')
    })
    const stalledAssertions = stalled.map((request) =>
      expect(request).rejects.toMatchObject({ code: 'TIMEOUT' })
    )
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS)
    await Promise.all(stalledAssertions)

    await expect(clickupRequest('token', '/after')).resolves.toEqual({ ok: true })
  })

  it('maps the deadline firing during the rate-limit sleep to a timeout', async () => {
    const { withClickUpContext, clickupRequest } = await loadClient()
    fetchMock.mockImplementation(async () => {
      const reset = (Date.now() + 4000) / 1000
      return new Response('{}', { status: 429, headers: { 'x-ratelimit-reset': String(reset) } })
    })
    const outcome = withClickUpContext(async (context) => {
      await fakeClockDelay(22_000)
      return clickupRequest('token', '/throttled', { signal: context.signal })
    })
    const assertion = expect(outcome).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(OPERATION_DEADLINE_MS)
    await assertion
  })

  it('maps the deadline firing during a request to a timeout', async () => {
    const { withClickUpContext, clickupRequest } = await loadClient()
    fetchMock.mockImplementation((_url, init) => abortableFetch(init))
    const outcome = withClickUpContext(async (context) => {
      await fakeClockDelay(10_000)
      return clickupRequest('token', '/slow', { signal: context.signal })
    })
    const assertion = expect(outcome).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(OPERATION_DEADLINE_MS)
    await assertion
  })

  it('tells a write that timed out during the request to check the task before retrying', async () => {
    const { withClickUpContext, clickupRequest } = await loadClient()
    fetchMock.mockImplementation((_url, init) => abortableFetch(init))
    const outcome = withClickUpContext(
      (context) => clickupRequest('token', '/comment', { method: 'POST', signal: context.signal }),
      { write: true }
    )
    const assertion = expect(outcome).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: "ClickUp didn't confirm in time. Check the task before trying again."
    })
    await vi.advanceTimersByTimeAsync(OPERATION_DEADLINE_MS)
    await assertion
  })

  it('tells a write whose operation deadline fired first to check the task before retrying', async () => {
    const { withClickUpContext, clickupRequest } = await loadClient()
    fetchMock.mockImplementation((_url, init) => abortableFetch(init))
    const outcome = withClickUpContext(
      async (context) => {
        await fakeClockDelay(10_000)
        return clickupRequest('token', '/comment', { method: 'POST', signal: context.signal })
      },
      { write: true }
    )
    const assertion = expect(outcome).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: "ClickUp didn't confirm in time. Check the task before trying again."
    })
    await vi.advanceTimersByTimeAsync(OPERATION_DEADLINE_MS)
    await assertion
  })

  it('passes the caller own cancellation through untouched', async () => {
    const { withClickUpContext, clickupRequest } = await loadClient()
    fetchMock.mockImplementation((_url, init) => abortableFetch(init))
    const caller = new AbortController()
    const outcome = withClickUpContext(
      (context) => clickupRequest('token', '/cancelled', { signal: context.signal }),
      { signal: caller.signal }
    )
    const assertion = expect(outcome).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(1_000)
    caller.abort()
    await assertion
  })
})

describe('connect deadline', () => {
  it('bounds the user and team requests together and saves nothing when it fires', async () => {
    const { connect } = await loadClient()
    fetchMock.mockImplementation((url, init) =>
      url.endsWith('/user')
        ? fakeClockDelay(12_000).then(() => jsonResponse({ user: { id: 1 } }))
        : abortableFetch(init)
    )
    const outcome = connect('token')
    await vi.advanceTimersByTimeAsync(OPERATION_DEADLINE_MS)
    await expect(outcome).resolves.toMatchObject({
      ok: false,
      error: 'ClickUp took too long to respond. Try again.'
    })
    expect(saveToken).not.toHaveBeenCalled()
  })
})
