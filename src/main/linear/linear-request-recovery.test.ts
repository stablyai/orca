import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import type { TimerOptions } from 'node:timers'
import type * as TimersPromises from 'node:timers/promises'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLinearClient, loadLinearSdk } from './linear-sdk'
import { linearTransportErrorCodes, recoverLinearQuery } from './linear-request-recovery'
import { createLocalFileSink } from '../observability/local-file-sink'
import { setActiveSink } from '../observability/tracer'
import type { RedactableSpan } from '../observability/redactor'
import { LinearAgentAccessError, linearError, toLinearAccessError } from './issue-context/errors'
import { sendLinearData, serveLinearHttp } from './linear-sdk-http.test-fixture'

const backoff = vi.hoisted(() => ({ started: vi.fn() }))
vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof TimersPromises>()
  return {
    ...actual,
    setTimeout: <T>(ms?: number, value?: T, options?: TimerOptions) => {
      const pending = actual.setTimeout(ms, value, options)
      backoff.started(ms, options?.signal)
      return pending
    }
  }
})

let server: Awaited<ReturnType<typeof serveLinearHttp>>
let reset = true
const viewer = { id: 'viewer-proof', displayName: 'Recovered viewer' }
const nativeFetch = globalThis.fetch
let traceDirectory: string
let sink: ReturnType<typeof createLocalFileSink>

function records(): RedactableSpan[] {
  sink.flush()
  let contents: string
  try {
    contents = readFileSync(sink.filePath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
  return contents
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function expectRecord(
  record: RedactableSpan | undefined,
  operation: string,
  attempt: number,
  codes: string[],
  outcome: string
): void {
  assert(record)
  expect(record.name).toBe('linear.request')
  expect(record.kind).toBe('client')
  expect(record.events).toEqual([])
  expect(record.attributes).toEqual({
    'linear.operation': operation,
    'linear.transport': 'native-fetch',
    'linear.attempts': attempt,
    'linear.attemptMs': expect.any(Number),
    'linear.elapsedMs': expect.any(Number),
    'linear.codes': codes
  })
  for (const key of ['linear.attemptMs', 'linear.elapsedMs']) {
    const value = record.attributes[key]
    assert(typeof value === 'number' && Number.isFinite(value) && value >= 0)
  }
  expect(record.exit).toEqual(
    outcome === 'Success'
      ? { _tag: outcome }
      : {
          _tag: outcome,
          cause: outcome === 'Failure' ? 'linear_request_failed' : 'linear_request_cancelled'
        }
  )
}

beforeEach(async () => {
  reset = true
  backoff.started.mockReset()
  traceDirectory = mkdtempSync(join(tmpdir(), 'linear-recovery-'))
  sink = createLocalFileSink({ filePath: join(traceDirectory, 'attempts.ndjson') })
  setActiveSink(sink)
  server = await serveLinearHttp((_receipt, response) => {
    if (reset) {
      response.destroy()
    } else {
      sendLinearData(response, { viewer })
    }
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  setActiveSink(null)
  sink.close()
  rmSync(traceDirectory, { recursive: true, force: true })
  await server.close()
})

it('recovers generated and raw SDK reads, retaining headers, options and raw metadata', async () => {
  const plain = new (loadLinearSdk().LinearClient)({ apiKey: 'proof', apiUrl: server.apiUrl })
  const generatedError: unknown = await plain.viewer.catch((error: unknown) => error)
  assert(generatedError instanceof Error && 'raw' in generatedError)
  assert(generatedError.raw instanceof Error && generatedError.raw.cause instanceof Error)
  expect(
    linearTransportErrorCodes(generatedError).some(
      (code) => code === 'UND_ERR_SOCKET' || code === 'ECONNRESET'
    )
  ).toBe(true)
  expect(server.receipts).toHaveLength(1)
  const rawError: unknown = await plain.client
    .rawRequest('query RawShape { viewer { id } }')
    .catch((error: unknown) => error)
  assert(rawError instanceof Error && rawError.cause instanceof Error)
  expect(
    linearTransportErrorCodes(rawError).some(
      (code) => code === 'UND_ERR_SOCKET' || code === 'ECONNRESET'
    )
  ).toBe(true)
  expect(server.receipts).toHaveLength(2)

  const signal = new AbortController().signal
  const client = createLinearClient({
    apiKey: 'AUTH_SENTINEL',
    apiUrl: server.apiUrl,
    signal,
    cache: 'no-store',
    headers: { 'x-constructor': 'retained' }
  })
  expect(client.options).toMatchObject({ signal, cache: 'no-store', apiUrl: server.apiUrl })
  client.client.setHeader('x-constructor', 'mutated')
  backoff.started.mockImplementationOnce(() => {
    reset = false
  })
  await expect(client.viewer).resolves.toMatchObject(viewer)
  expect(server.receipts).toHaveLength(4)
  expect(server.receipts.slice(2).map((receipt) => receipt.headers.authorization)).toEqual([
    'AUTH_SENTINEL',
    'AUTH_SENTINEL'
  ])
  expect(server.receipts.slice(2).map((receipt) => receipt.headers['x-constructor'])).toEqual([
    'mutated',
    'mutated'
  ])
  client.client.setHeaders({
    authorization: 'AUTH_SENTINEL',
    'x-constructor': 'replaced',
    'x-set-headers': 'retained'
  })
  client.client.setHeader('x-set-header', 'retained')
  reset = true
  backoff.started.mockImplementationOnce(() => {
    reset = false
  })
  const raw = await client.client.rawRequest<{ viewer: typeof viewer }, { id: string }>(
    ' \n query RawProof($id: ID!) { viewer { id } }',
    { id: 'variable-proof' },
    new Headers({ 'x-per-request': 'retained' })
  )
  expect(raw.data?.viewer).toEqual(viewer)
  expect(raw.status).toBe(200)
  expect(raw.headers?.get('x-linear-proof')).toBe('retained')
  expect(raw.extensions).toEqual({ proof: 'retained' })
  expect(server.receipts).toHaveLength(6)
  for (const receipt of server.receipts.slice(4)) {
    expect(receipt).toMatchObject({
      method: 'POST',
      variables: { id: 'variable-proof' },
      headers: {
        'x-constructor': 'replaced',
        'x-set-headers': 'retained',
        'x-set-header': 'retained',
        'x-per-request': 'retained',
        authorization: 'AUTH_SENTINEL'
      }
    })
  }
  expect(backoff.started.mock.calls.map(([ms]) => ms)).toEqual([100, 100])
  const spans = records()
  expect(spans).toHaveLength(4)
  expectRecord(spans[0], 'query', 1, linearTransportErrorCodes(generatedError), 'Failure')
  expectRecord(spans[1], 'query', 2, [], 'Success')
  expectRecord(spans[3], 'query', 2, [], 'Success')
})

it('stops persistent real resets at three, sanitizes diagnostics and later reuses the same client', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    try {
      return await nativeFetch(input, init)
    } catch (error) {
      assert(error instanceof Error)
      error.message += ' RAW_ERROR_SENTINEL'
      Object.assign(error, {
        query: 'QUERY_SENTINEL',
        variables: { body: 'VARIABLE_SENTINEL' },
        auth: 'AUTH_SENTINEL',
        url: 'https://URL_SENTINEL.invalid/graphql',
        headers: { authorization: 'HEADER_SENTINEL' },
        stack: 'Error: STACK_SENTINEL\n    at https://STACK_URL_SENTINEL.invalid/request'
      })
      throw error
    }
  })
  const client = createLinearClient({ apiKey: 'AUTH_SENTINEL', apiUrl: server.apiUrl })
  const failure: unknown = await client.viewer.catch((error: unknown) => error)
  assert(failure instanceof Error && 'raw' in failure && failure.raw instanceof Error)
  Object.assign(failure, {
    query: 'QUERY_SENTINEL',
    variables: { body: 'VARIABLE_SENTINEL' },
    auth: 'AUTH_SENTINEL'
  })
  Object.assign(failure.raw, { extra: 'RAW_ERROR_SENTINEL' })
  const converted = toLinearAccessError(failure)
  expect(converted).toBeInstanceOf(LinearAgentAccessError)
  expect(converted).toMatchObject({ code: 'linear_network_error', message: failure.message })
  expect(converted.data).toBeUndefined()
  expect(converted.cause).toBeInstanceOf(Error)
  assert(converted.cause instanceof Error)
  const codes = linearTransportErrorCodes(failure)
  expect(converted.cause.message).toBe(`Linear transport failure: ${codes.join(', ')}`)
  expect(converted.cause.cause).toBeUndefined()
  const spans = records()
  expect(spans).toHaveLength(3)
  spans.forEach((span, index) => expectRecord(span, 'query', index + 1, codes, 'Failure'))
  const finalDiagnostic =
    inspect(converted.cause, { depth: null }) + readFileSync(sink.filePath, 'utf8')
  for (const sentinel of [
    'QUERY_SENTINEL',
    'VARIABLE_SENTINEL',
    'AUTH_SENTINEL',
    'RAW_ERROR_SENTINEL',
    'URL_SENTINEL',
    'HEADER_SENTINEL',
    'STACK_SENTINEL',
    'STACK_URL_SENTINEL'
  ]) {
    expect(finalDiagnostic).not.toContain(sentinel)
  }
  const existing = linearError('linear_permission_denied', 'Existing message', { preserved: true })
  expect(toLinearAccessError(existing)).toBe(existing)
  expect(server.receipts).toHaveLength(3)
  expect(backoff.started.mock.calls.map(([ms]) => ms)).toEqual([100, 200])
  reset = false
  await expect(client.viewer).resolves.toMatchObject(viewer)
  expect(server.receipts).toHaveLength(4)
  expectRecord(records()[3], 'query', 1, [], 'Success')
})

it('never replays received mutations, unknown documents or constructor body/method overrides', async () => {
  const client = createLinearClient({ apiKey: 'proof', apiUrl: server.apiUrl })
  const mutationFailure: unknown = await client
    .updateIssue('issue-proof', { title: 'mutation-proof' })
    .catch((error: unknown) => error)
  assert(mutationFailure instanceof Error)
  expect(server.receipts).toHaveLength(1)
  expect(server.receipts[0].query.trimStart()).toMatch(/^mutation\b/)
  expectRecord(
    records().at(-1),
    'mutation',
    1,
    linearTransportErrorCodes(mutationFailure),
    'Failure'
  )
  for (const query of [
    '# comment\nquery Commented { viewer { id } }',
    'fragment Unknown on User { id }',
    'subscription Changes { viewer { id } }'
  ]) {
    const before = server.receipts.length
    const failure: unknown = await client.client.rawRequest(query).catch((error: unknown) => error)
    assert(failure instanceof Error)
    expect(server.receipts).toHaveLength(before + 1)
    expectRecord(records().at(-1), 'unknown', 1, linearTransportErrorCodes(failure), 'Failure')
  }
  for (const override of [
    { method: 'POST' },
    { body: JSON.stringify({ query: 'mutation Override { write }' }) }
  ]) {
    const before = server.receipts.length
    const overridden = createLinearClient({ apiKey: 'proof', apiUrl: server.apiUrl, ...override })
    Object.assign(overridden, { options: {} })
    await expect(
      overridden.client.rawRequest('query LooksSafe { viewer { id } }')
    ).rejects.toThrow()
    expect(server.receipts).toHaveLength(before + 1)
  }
  expect(backoff.started).not.toHaveBeenCalled()
  backoff.started.mockImplementationOnce(() => {
    client.options.body = JSON.stringify({ query: 'mutation ChangedDuringWait { write }' })
  })
  const before = server.receipts.length
  await expect(client.client.rawRequest('query BeforeWait { viewer { id } }')).rejects.toThrow()
  expect(server.receipts).toHaveLength(before + 1)
  expect(backoff.started).toHaveBeenCalledExactlyOnceWith(100, undefined)
})

it('leaves HTTP authentication, permission, rate limit and GraphQL failures at one attempt', async () => {
  await server.close()
  let status = 401
  server = await serveLinearHttp((_receipt, response) => {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ errors: [{ message: 'Provider refusal' }] }))
  })
  const client = createLinearClient({ apiKey: 'proof', apiUrl: server.apiUrl })
  for (status of [401, 403, 429, 503]) {
    const before = server.receipts.length
    await expect(client.viewer).rejects.toThrow('Provider refusal')
    expect(server.receipts).toHaveLength(before + 1)
  }
  expect(backoff.started).not.toHaveBeenCalled()
})

it('aborts an active backoff with the original deadline reason and no new request', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  const controller = new AbortController()
  const reason = Object.assign(
    new DOMException('Original caller deadline ABORT_REASON_SENTINEL', 'TimeoutError'),
    {
      cause: Object.assign(new Error('ABORT_CAUSE_SENTINEL'), { code: 'ECONNRESET' }),
      stack: 'ABORT_STACK_SENTINEL',
      url: 'https://ABORT_URL_SENTINEL.invalid',
      headers: { authorization: 'ABORT_HEADER_SENTINEL' }
    }
  )
  const client = createLinearClient({
    apiKey: 'proof',
    apiUrl: server.apiUrl,
    signal: controller.signal
  })
  backoff.started.mockImplementationOnce(() => controller.abort(reason))
  await expect(client.client.rawRequest('query Deadline { viewer { id } }')).rejects.toBe(reason)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(backoff.started).toHaveBeenCalledExactlyOnceWith(100, controller.signal)
  expect(controller.signal.reason).toBe(reason)
  await expect(client.client.rawRequest('query AlreadyAborted { viewer { id } }')).rejects.toBe(
    reason
  )
  expect(fetch).toHaveBeenCalledTimes(1)
  const spans = records()
  expect(spans).toHaveLength(1)
  const failure = await fetch.mock.results[0].value.catch((error: unknown) => error)
  const codes = linearTransportErrorCodes(failure)
  expect(codes.some((code) => code === 'UND_ERR_SOCKET' || code === 'ECONNRESET')).toBe(true)
  expectRecord(spans[0], 'query', 1, codes, 'Failure')
  const converted = toLinearAccessError(reason)
  expect(converted.message).toBe(reason.message)
  expect(converted.cause).toEqual(new Error('Linear transport failure: ECONNRESET'))
  expect(inspect(converted.cause) + readFileSync(sink.filePath, 'utf8')).not.toContain('SENTINEL')
})

it('persists the failed first attempt while the real HTTP retry is still pending', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
  await server.close()
  let received = () => {}
  let release = () => {}
  const pendingReceipt = new Promise<void>((resolve) => {
    received = resolve
  })
  server = await serveLinearHttp((_receipt, response) => {
    if (server.receipts.length === 1) {
      response.destroy()
    } else {
      release = () => sendLinearData(response, { viewer })
      received()
    }
  })
  const pending = createLinearClient({ apiKey: 'proof', apiUrl: server.apiUrl }).viewer
  await pendingReceipt
  try {
    const spans = records()
    expect(spans).toHaveLength(1)
    const failure = await fetch.mock.results[0].value.catch((error: unknown) => error)
    const codes = linearTransportErrorCodes(failure)
    expect(codes.some((code) => code === 'UND_ERR_SOCKET' || code === 'ECONNRESET')).toBe(true)
    expectRecord(spans[0], 'query', 1, codes, 'Failure')
  } finally {
    release()
    await pending
  }
  expectRecord(records()[1], 'query', 2, [], 'Success')
})

it.each([
  { name: 'slow reset', code: 'ECONNRESET', durations: [25_000], attempts: 1 },
  { name: 'slow coded timeout', code: 'ETIMEDOUT', durations: [25_000], attempts: 1 },
  { name: 'fast coded timeout', code: 'ETIMEDOUT', durations: [10], attempts: 2 },
  {
    name: 'fast native connect timeout',
    code: 'UND_ERR_CONNECT_TIMEOUT',
    errorName: 'ConnectTimeoutError',
    durations: [10],
    attempts: 2
  },
  { name: 'fast then slow failure', code: 'ECONNRESET', durations: [10, 25_000], attempts: 2 },
  { name: 'first wait cannot fit', code: 'ECONNRESET', durations: [900], attempts: 1 },
  { name: 'second wait cannot fit', code: 'ECONNRESET', durations: [100, 600], attempts: 2 },
  { name: 'timer overshoots', code: 'ECONNRESET', durations: [10], attempts: 1, overshoot: 1000 },
  { name: 'just inside window', code: 'ECONNRESET', durations: [899], attempts: 2 }
])(
  'uses a strict monotonic retry-start window: $name',
  async ({ code, durations, attempts, ...testCase }) => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    backoff.started.mockImplementation((ms: number) => {
      clock += testCase.overshoot ?? ms
    })
    const failures = durations.map(() =>
      Object.assign(new Error('private failure'), {
        code,
        name: 'errorName' in testCase ? testCase.errorName : 'Error'
      })
    )
    let calls = 0
    const pending = recoverLinearQuery(
      'query Budget { viewer { id } }',
      async () => {
        const index = calls++
        clock += durations[index] ?? 0
        if (failures[index]) {
          throw failures[index]
        }
        return 'recovered'
      },
      {}
    )
    await (attempts > durations.length
      ? expect(pending).resolves.toBe('recovered')
      : expect(pending).rejects.toBe(failures[attempts - 1]))
    expect(calls).toBe(attempts)
    const spans = records()
    expect(spans).toHaveLength(attempts)
    spans.forEach((span, index) => {
      const failed = index < failures.length
      expectRecord(span, 'query', index + 1, failed ? [code] : [], failed ? 'Failure' : 'Success')
      expect(span.attributes['linear.attemptMs']).toBe(durations[index] ?? 0)
      expect(span.attributes['linear.elapsedMs']).toBe(
        durations.slice(0, index + 1).reduce((sum, duration) => sum + duration, 0) +
          (index ? 100 : 0)
      )
    })
  }
)

it('vetoes permanent, unknown, named abort/timeout and bounded-graph failures without leaking secrets', async () => {
  const resetError = () => Object.assign(new Error('RAW_SECRET'), { code: 'ECONNRESET' })
  const cycle = resetError()
  cycle.cause = cycle
  let deep: Error = resetError()
  for (let i = 0; i < 8; i++) {
    deep = new Error('WRAPPER_SECRET', { cause: deep })
  }
  const failures = [
    ...[
      'ENOTFOUND',
      'ECONNABORTED',
      'EPROTO',
      'CERT_HAS_EXPIRED',
      'UND_ERR_DESTROYED',
      'UND_ERR_CLOSED',
      'UPPERCASE_SECRET'
    ].map((code) => Object.assign(new Error('ERROR_SECRET'), { code })),
    ...['AbortError', 'TimeoutError'].map((name) => Object.assign(resetError(), { name })),
    new Error('ECONNRESET is only a message'),
    new AggregateError([resetError(), new Error('UNKNOWN_SECRET')], 'AGGREGATE_SECRET'),
    new AggregateError(
      [resetError(), Object.assign(new Error('TLS_SECRET'), { code: 'CERT_HAS_EXPIRED' })],
      'AGGREGATE_SECRET'
    ),
    new AggregateError(Array.from({ length: 17 }, resetError), 'AGGREGATE_SECRET'),
    new Error('unknown child', { cause: false }),
    Object.assign(resetError(), { raw: 'RAW_SECRET' }),
    cycle,
    deep
  ]
  for (const failure of failures) {
    const request = vi.fn().mockRejectedValue(failure)
    await expect(
      recoverLinearQuery('query PRIVATE_DOCUMENT { privateField }', request, {})
    ).rejects.toBe(failure)
    expect(request).toHaveBeenCalledTimes(1)
    expectRecord(
      records().at(-1),
      'query',
      1,
      linearTransportErrorCodes(failure),
      ['AbortError', 'TimeoutError'].includes(failure.name) ? 'Interrupted' : 'Failure'
    )
    expect(inspect(toLinearAccessError(failure).cause)).not.toContain('SECRET')
    if (
      'code' in failure &&
      (failure.code === 'UND_ERR_DESTROYED' || failure.code === 'UND_ERR_CLOSED')
    ) {
      expect(linearTransportErrorCodes(failure)).toEqual([failure.code])
      expect(toLinearAccessError(failure).cause).toEqual(
        new Error(`Linear transport failure: ${failure.code}`)
      )
    }
  }
  expect(readFileSync(sink.filePath, 'utf8')).not.toMatch(/SECRET|PRIVATE_DOCUMENT|privateField/)
  expect(backoff.started).not.toHaveBeenCalled()
})

it('admits transient SDK raw aggregates only within the distinct-node budget', async () => {
  const resetError = () => Object.assign(new Error('NODE_SECRET'), { code: 'ECONNRESET' })
  for (const [failure, retryable] of [
    [
      Object.assign(new Error('SDK_SECRET'), {
        raw: new AggregateError([resetError(), resetError()], 'AGGREGATE_SECRET')
      }),
      true
    ],
    [new AggregateError(Array.from({ length: 15 }, resetError), 'SIXTEEN_NODE_SECRET'), true],
    [new AggregateError(Array.from({ length: 16 }, resetError), 'SEVENTEEN_NODE_SECRET'), false]
  ] as const) {
    const before = records().length
    const request = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue('recovered')
    const pending = recoverLinearQuery('query Nodes { viewer { id } }', request, {})
    await (retryable
      ? expect(pending).resolves.toBe('recovered')
      : expect(pending).rejects.toBe(failure))
    expect(request).toHaveBeenCalledTimes(retryable ? 2 : 1)
    const spans = records().slice(before)
    expect(spans).toHaveLength(retryable ? 2 : 1)
    expectRecord(spans[0], 'query', 1, ['ECONNRESET'], 'Failure')
    if (retryable) {
      expectRecord(spans[1], 'query', 2, [], 'Success')
    }
    expect(inspect(toLinearAccessError(failure).cause)).not.toContain('SECRET')
  }
  expect(backoff.started.mock.calls.map(([ms]) => ms)).toEqual([100, 100])
  expect(readFileSync(sink.filePath, 'utf8')).not.toContain('SECRET')
})

it('delegates non-string documents and own undefined overrides once', async () => {
  for (const [document, options] of [
    [null, {}],
    ['query Named { viewer { id } }', { body: undefined }],
    ['query Named { viewer { id } }', { method: undefined }]
  ] as const) {
    const failure = Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    const request = vi.fn().mockRejectedValue(failure)
    await expect(recoverLinearQuery(document, request, options)).rejects.toBe(failure)
    expect(request).toHaveBeenCalledTimes(1)
    expectRecord(records().at(-1), 'unknown', 1, ['ECONNRESET'], 'Failure')
  }
})

it.each(['before', 'wait', 'success', 'failure'] as const)(
  'preserves false abort reason identity at %s',
  async (phase) => {
    const controller = new AbortController()
    if (phase === 'before') {
      controller.abort(false)
    }
    if (phase === 'wait') {
      backoff.started.mockImplementationOnce(() => controller.abort(false))
    }
    const request = vi.fn(async () => {
      if (phase === 'success' || phase === 'failure') {
        controller.abort(false)
      }
      if (phase !== 'success') {
        throw Object.assign(new Error('PRIVATE_ABORT_ERROR'), { code: 'ECONNRESET' })
      }
      return 'discarded'
    })
    await expect(
      recoverLinearQuery('query Abort { viewer { id } }', request, { signal: controller.signal })
    ).rejects.toBe(false)
    expect(request).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1)
    const spans = records()
    expect(spans).toHaveLength(phase === 'before' ? 0 : 1)
    if (phase !== 'before') {
      expectRecord(
        spans[0],
        'query',
        1,
        phase === 'wait' ? ['ECONNRESET'] : [],
        phase === 'wait' ? 'Failure' : 'Interrupted'
      )
    }
  }
)

it('keeps success and original failure behavior with no sink or a throwing sink', async () => {
  const failure = Object.assign(new Error('PRIVATE_SINK_FAILURE'), { code: 'ECONNRESET' })
  for (const active of [
    null,
    {
      push() {
        throw new Error('sink failed')
      },
      flush() {},
      close() {}
    }
  ]) {
    setActiveSink(active)
    const request = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue('recovered')
    await expect(recoverLinearQuery(' \t { viewer { id } }', request, {})).resolves.toBe(
      'recovered'
    )
    expect(request).toHaveBeenCalledTimes(2)
    await expect(
      recoverLinearQuery(
        'mutation Write { write }',
        async () => {
          throw failure
        },
        {}
      )
    ).rejects.toBe(failure)
  }
  expect(records()).toEqual([])
})
