import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startExternalGatewayBridge } from './openai-http-adapter.mjs'
import { validateExternalAcpProfile } from './external-acp-profile.mjs'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function fixture(root: string) {
  return validateExternalAcpProfile({
    nativeCommand: join(root, 'native-server'),
    nativeHome: join(root, 'profile-home'),
    gatewayBaseUrl: 'https://gateway.example.test',
    modelIds: ['model-alpha', 'pi'],
    defaultModel: 'model-alpha-high',
    timeoutMs: 40
  })
}

function generation(_model: string) {
  return {
    contents: [{ role: 'user', parts: [{ text: 'Example' }] }],
    tools: [{ functionDeclarations: [{ name: 'lookup', description: 'Read one record' }] }]
  }
}

function post(
  bridge: { baseUrl: string; headers: Record<string, string> },
  model: string,
  body = generation(model),
  signal?: AbortSignal
) {
  return fetch(`${bridge.baseUrl}/v1beta/models/${model}:streamGenerateContent`, {
    method: 'POST',
    headers: { ...bridge.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {})
  })
}

it('delivers native text and function calls and retries transient transport errors once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-http-tools-'))
  roots.push(root)
  const calls: { model: string; tools: { function: { name: string } }[] }[] = []
  const fetchImpl = vi.fn(async (_url, init) => {
    calls.push(JSON.parse(init.body))
    const lines = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"lookup","arguments":"{\\"id\\":"}}]},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"7}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}',
      'data: [DONE]'
    ]
    return new Response(`${lines.join('\r\n\r\n')}\r\n\r\n`, { status: 200 })
  })
  const bridge = await startExternalGatewayBridge(fixture(root), {
    getToken: async () => 'fixture-token',
    fetchImpl
  })
  try {
    const response = await post(bridge, 'model-alpha-high')
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('"name":"lookup"')
    expect(body).toContain('"args":{"id":7}')
    expect(body).toContain('"finishReason":"STOP"')
    expect(body).toContain('"totalTokenCount":3')
    expect(calls[0].model).toBe('model-alpha')
    expect(calls[0].tools[0].function.name).toBe('lookup')
  } finally {
    await bridge.close()
    await bridge.close()
  }
})

it('prefers exact and longest model matches over shorter prefix aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-http-model-alias-'))
  roots.push(root)
  const profile = validateExternalAcpProfile({
    nativeCommand: join(root, 'native-server'),
    nativeHome: join(root, 'profile-home'),
    gatewayBaseUrl: 'https://gateway.example.test/v1',
    modelIds: ['gpt-5', 'gpt-5-mini'],
    defaultModel: 'gpt-5-mini'
  })
  const calls: { model: string }[] = []
  const bridge = await startExternalGatewayBridge(profile, {
    getToken: async () => 'fixture-token',
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body))
      return new Response(
        'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n',
        { status: 200 }
      )
    }
  })
  try {
    await post(bridge, 'gpt-5-mini')
    expect(calls[0].model).toBe('gpt-5-mini')
  } finally {
    await bridge.close()
  }
})

it('retries a transient HTTP failure once, then surfaces its response through the same stream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-http-retry-'))
  roots.push(root)
  let calls = 0
  const fetchImpl = vi.fn(async () => {
    calls += 1
    if (calls === 1) {
      return new Response('{}', { status: 503 })
    }
    return new Response(
      'data: {"choices":[{"delta":{"content":"retry answer"},"finish_reason":"stop"}]}\n\n',
      {
        status: 200
      }
    )
  })
  const bridge = await startExternalGatewayBridge(fixture(root), {
    getToken: async () => 'fixture-token',
    fetchImpl
  })
  try {
    const response = await post(bridge, 'pi')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('retry answer')
    expect(calls).toBe(2)
  } finally {
    await bridge.close()
  }
})

it('redacts transport failures after one retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-http-errors-'))
  roots.push(root)
  const fetchImpl = vi.fn(async () => {
    throw new Error('Bearer fixture-secret-token')
  })
  const bridge = await startExternalGatewayBridge(fixture(root), {
    getToken: async () => 'fixture-secret-token',
    fetchImpl
  })
  try {
    const response = await post(bridge, 'pi')
    expect(response.status).toBe(504)
    expect(await response.text()).not.toContain('fixture-secret-token')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  } finally {
    await bridge.close()
  }
})

it('rejects malformed upstream event data as a gateway protocol failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-http-malformed-output-'))
  roots.push(root)
  const bridge = await startExternalGatewayBridge(fixture(root), {
    getToken: async () => 'fixture-token',
    fetchImpl: async () => new Response('data: {not-json}\n\n', { status: 200 })
  })
  try {
    const response = await post(bridge, 'pi')
    expect(response.status).toBe(502)
  } finally {
    await bridge.close()
  }
})

it('aborts a running upstream turn without retrying it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-http-interrupted-'))
  roots.push(root)
  let started = false
  let aborted = 0
  const fetchImpl = vi.fn((_url, init) => {
    started = true
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted += 1
        reject(new Error('interrupted upstream turn'))
      })
    })
  })
  const bridge = await startExternalGatewayBridge(
    { ...fixture(root), timeoutMs: 60_000 },
    {
      getToken: async () => 'fixture-token',
      fetchImpl
    }
  )
  const turn = post(bridge, 'pi')
  await vi.waitFor(() => expect(started).toBe(true))
  bridge.abortPending()
  const response = await turn
  expect(response.status).toBe(504)
  expect(aborted).toBe(1)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  await bridge.close()
})

it('retries a timed out upstream once before returning a bounded failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-http-timeout-'))
  roots.push(root)
  const fetchImpl = vi.fn((_url, init) => {
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    })
  })
  const bridge = await startExternalGatewayBridge(fixture(root), {
    getToken: async () => 'fixture-token',
    fetchImpl
  })
  try {
    const response = await post(bridge, 'pi')
    expect(response.status).toBe(504)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  } finally {
    await bridge.close()
  }
})

it('aborts upstream work when the complete request consumer disconnects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-http-response-disconnect-'))
  roots.push(root)
  let started = false
  let aborted = 0
  const fetchImpl = vi.fn((_url, init) => {
    started = true
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted += 1
        reject(new Error('response consumer disconnected'))
      })
    })
  })
  const bridge = await startExternalGatewayBridge(
    { ...fixture(root), timeoutMs: 60_000 },
    {
      getToken: async () => 'fixture-token',
      fetchImpl
    }
  )
  try {
    const request = httpRequest(`${bridge.baseUrl}/v1beta/models/pi:streamGenerateContent`, {
      method: 'POST',
      headers: bridge.headers
    })
    request.on('error', () => {})
    request.end(JSON.stringify(generation('pi')))
    await vi.waitFor(() => expect(started).toBe(true))
    request.destroy()
    await vi.waitFor(() => expect(aborted).toBe(1))
    await bridge.close()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  } finally {
    await bridge.close()
  }
})

it('requires the per-launch loopback credential before reading or forwarding a request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-http-loopback-auth-'))
  roots.push(root)
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n',
        { status: 200 }
      )
  )
  const bridge = await startExternalGatewayBridge(fixture(root), {
    getToken: async () => 'fixture-token',
    fetchImpl
  })
  try {
    const rejected = await fetch(`${bridge.baseUrl}/v1beta/models/pi:streamGenerateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(generation('pi'))
    })
    expect(rejected.status).toBe(401)
    expect(fetchImpl).not.toHaveBeenCalled()
  } finally {
    await bridge.close()
  }
})

it('forwards an upstream text event before the generation completes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-http-incremental-'))
  roots.push(root)
  const encoder = new TextEncoder()
  let releaseGeneration = () => {}
  const secondEvent = new Promise<void>((resolve) => {
    releaseGeneration = resolve
  })
  const bridge = await startExternalGatewayBridge(fixture(root), {
    getToken: async () => 'fixture-token',
    fetchImpl: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"first"}}]}\r\n\r\n')
            )
            await secondEvent
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"second"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n'
              )
            )
            controller.close()
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
  })
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await post(bridge, 'pi')
    reader = response.body!.getReader()
    const fallback = setTimeout(releaseGeneration, 1000)
    const decoder = new TextDecoder()
    let firstText = ''
    while (!/\r?\n\r?\n/.test(firstText)) {
      const next = await reader.read()
      if (next.done) {
        throw new Error('first event did not complete')
      }
      firstText += decoder.decode(next.value, { stream: true })
    }
    clearTimeout(fallback)
    expect(firstText).toContain('first')
    expect(firstText).not.toContain('second')
    releaseGeneration()
    let remaining = ''
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        break
      }
      remaining += new TextDecoder().decode(next.value)
    }
    expect(remaining).toContain('second')
  } finally {
    releaseGeneration()
    await reader?.cancel().catch(() => {})
    await bridge.close()
  }
})

it('returns a stream-level safe error after a converted event has started', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-http-late-stream-error-'))
  roots.push(root)
  const encoder = new TextEncoder()
  const bridge = await startExternalGatewayBridge(fixture(root), {
    getToken: async () => 'fixture-token',
    fetchImpl: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"prefix"}}]}\n\n')
            )
            controller.enqueue(encoder.encode('data: {not-json}\n\n'))
            controller.close()
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
  })
  try {
    const response = await post(bridge, 'pi')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()
    expect(body).toContain('prefix')
    expect(body).toContain('"code":502')
    expect(body).not.toContain('{not-json}')
  } finally {
    await bridge.close()
  }
})

it('rejects an unterminated oversized upstream event without retaining it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-http-event-limit-'))
  roots.push(root)
  const bridge = await startExternalGatewayBridge(fixture(root), {
    getToken: async () => 'fixture-token',
    fetchImpl: async () => new Response(`data: ${'x'.repeat(1_048_577)}`, { status: 200 })
  })
  try {
    const response = await post(bridge, 'pi')
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('xxxx')
  } finally {
    await bridge.close()
  }
})

it('fails malformed requests and reports cancellation without keeping retry work alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-http-cancel-'))
  roots.push(root)
  const token = 'fixture-token'
  const stopped = startExternalGatewayBridge(fixture(root), {
    getToken: async () => token,
    fetchImpl: async () => new Response('ok', { status: 200 })
  })
  const malformed = await fetch(
    `${(await stopped).baseUrl}/v1beta/models/pi:streamGenerateContent`,
    {
      method: 'POST',
      headers: (await stopped).headers,
      body: '{bad json'
    }
  )
  expect(malformed.status).toBe(400)
  await (await stopped).close()

  const cancelController = new AbortController()
  const fetchImpl = vi.fn((_url, init) => {
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () =>
        reject(new Error('External ACP turn was canceled'))
      )
      cancelController.signal.addEventListener('abort', () =>
        reject(new Error('External ACP turn was canceled'))
      )
    })
  })
  const bridge = await startExternalGatewayBridge(fixture(root), {
    getToken: async () => token,
    fetchImpl
  })
  const turn = post(bridge, 'pi', generation('pi'), cancelController.signal)
  cancelController.abort()
  await expect(turn).rejects.toThrow()
  expect(fetchImpl).not.toHaveBeenCalled()
  await bridge.close()
})

it('bounds complete events without rejecting several small events in one chunk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-http-complete-limit-'))
  roots.push(root)
  const event = `data: {"choices":[{"delta":{"content":"${'x'.repeat(1_048_577)}"}}]}\r\n\r\n`
  const bridge = await startExternalGatewayBridge(fixture(root), {
    getToken: async () => 'fixture-token',
    fetchImpl: async () => new Response(event, { status: 200 })
  })
  try {
    const response = await post(bridge, 'pi')
    expect(response.status).toBe(502)
  } finally {
    await bridge.close()
  }

  const batchRoot = await mkdtemp(join(tmpdir(), 'orca-external-http-event-batch-'))
  roots.push(batchRoot)
  const batch = Array.from(
    { length: 9000 },
    (_, index) =>
      `data: {"choices":[{"delta":{"content":"${index === 8999 ? 'last-small-event' : 'x'.repeat(96)}"}}]}`
  ).join('\r\n\r\n')
  const batchBridge = await startExternalGatewayBridge(fixture(batchRoot), {
    getToken: async () => 'fixture-token',
    fetchImpl: async () => new Response(batch, { status: 200 })
  })
  try {
    const response = await post(batchBridge, 'pi')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('last-small-event')
  } finally {
    await batchBridge.close()
  }
})
