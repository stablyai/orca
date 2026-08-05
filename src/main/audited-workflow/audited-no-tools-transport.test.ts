// The Byesu wire CONTRACT: Responses API, not chat/completions.
//
// These cases replace `fetch` rather than the dispatcher, deliberately. A suite
// that overrode the dispatcher would bypass the very code under test — the
// request this module builds and the envelope it parses are the contract, so
// they must be exercised through the real dispatchNoToolsTurn.
//
// NO NETWORK. NO REAL KEY. The key store is mocked with a sentinel value that
// every assertion below then proves cannot escape.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_TOOLS_LIMITS } from '../../shared/audited-audit-mode-types'

// A value shaped like a credential, so a leak into a URL, a log, or a body is
// detectable by substring rather than by inspection.
const SENTINEL_KEY = 'sk-SENTINEL-no-tools-transport-0123456789'

vi.mock('./audited-codex-provider-key-store', () => ({
  readAuditedCodexProviderKey: () => SENTINEL_KEY,
  hasAuditedCodexProviderKey: () => true
}))

const {
  buildResponsesRequestBody,
  buildResponsesUrl,
  dispatchNoToolsTurn,
  setNoToolsFetchForTests
} = await import('./audited-no-tools-transport')
const { getSoleAuditedCodexProvider } = await import('./audited-codex-provider-registry')

type Captured = { url: string; init: RequestInit }
let captured: Captured[]

/** Installs a fetch that records the request and returns `body` as JSON. */
function respondWith(body: unknown, status = 200): void {
  setNoToolsFetchForTests(async (url, init) => {
    captured.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  })
}

function messages() {
  return [
    { role: 'system' as const, content: 'You are a code auditor with NO tools.' },
    { role: 'user' as const, content: '## Task\nAdd a thing' }
  ]
}

/** A well-formed Responses success envelope. */
function okEnvelope(text: string): unknown {
  return {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
    ]
  }
}

beforeEach(() => {
  captured = []
})

afterEach(() => {
  setNoToolsFetchForTests(undefined)
  vi.restoreAllMocks()
})

describe('request URL and method', () => {
  it('POSTs to the Responses endpoint, never chat/completions', async () => {
    respondWith(okEnvelope('{"verdict":"approved"}'))
    await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })

    expect(captured).toHaveLength(1)
    // The registry declares wireApi 'responses', and audited-codex-launch-plan
    // passes that same value to Codex — so both transports must address the
    // same protocol at the same provider.
    expect(captured[0].url).toBe('https://byesu.com/v1/responses')
    expect(captured[0].url).not.toContain('chat/completions')
    expect(captured[0].init.method).toBe('POST')
  })

  it('derives the URL from the registry base, tolerating a trailing slash', () => {
    expect(buildResponsesUrl('https://byesu.com/v1')).toBe('https://byesu.com/v1/responses')
    expect(buildResponsesUrl('https://byesu.com/v1/')).toBe('https://byesu.com/v1/responses')
    // The registry value itself, so a base-URL change is caught here.
    expect(buildResponsesUrl(getSoleAuditedCodexProvider().baseUrl)).toMatch(/^https:\/\//)
  })

  it('refuses to follow a redirect', async () => {
    respondWith(okEnvelope('x'))
    await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })
    // A 3xx to an attacker host would otherwise replay the Authorization header.
    expect(captured[0].init.redirect).toBe('error')
  })
})

describe('authorization header construction', () => {
  it('sends a Bearer header built from the stored key', async () => {
    respondWith(okEnvelope('x'))
    await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })

    const headers = captured[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${SENTINEL_KEY}`)
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('never places the key in the URL or the request body', async () => {
    respondWith(okEnvelope('x'))
    await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })

    expect(captured[0].url).not.toContain(SENTINEL_KEY)
    expect(String(captured[0].init.body)).not.toContain(SENTINEL_KEY)
  })

  it('never logs the key, the header, or the body on an HTTP error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    respondWith({ error: { code: 'server_error' } }, 500)

    await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })

    const logged = [...errorSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String).join(' ')
    expect(logged).not.toContain(SENTINEL_KEY)
    expect(logged).not.toContain('Bearer')
    expect(logged).not.toContain('Authorization')
    // The status is genuinely useful and carries nothing sensitive.
    expect(logged).toContain('500')
  })
})

describe('Responses request body', () => {
  it('uses Responses fields, not chat/completions fields', async () => {
    respondWith(okEnvelope('x'))
    await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })
    const body = JSON.parse(String(captured[0].init.body))

    expect(body.model).toBe(getSoleAuditedCodexProvider().defaultModel)
    expect(body.max_output_tokens).toBe(NO_TOOLS_LIMITS.maxOutputTokens)
    expect(body.input).toBeInstanceOf(Array)
    // The chat/completions spellings must be ABSENT — sending them to a
    // Responses endpoint is a 400, not a graceful degradation.
    expect(body).not.toHaveProperty('messages')
    expect(body).not.toHaveProperty('max_tokens')
  })

  it('carries the system prompt as `instructions`, not an input role', () => {
    const body = buildResponsesRequestBody('m', messages())
    expect(body.instructions).toContain('NO tools')
    const input = body.input as { role: string }[]
    expect(input.every((item) => item.role !== 'system')).toBe(true)
  })

  it('wraps content in typed parts, using the role-correct part type', () => {
    const body = buildResponsesRequestBody('m', [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' }
    ])
    const input = body.input as { role: string; content: { type: string; text: string }[] }[]

    expect(input[0].content[0]).toEqual({ type: 'input_text', text: 'u' })
    // An assistant turn replayed as input_text is rejected as a malformed item.
    expect(input[1].content[0]).toEqual({ type: 'output_text', text: 'a' })
  })

  it('declares NO tools or function-calling of any kind', () => {
    const body = buildResponsesRequestBody('m', messages())
    // Their ABSENCE is the no-tools property.
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('tool_choice')
    expect(body).not.toHaveProperty('functions')
    expect(body).not.toHaveProperty('function_call')
  })

  it('disables streaming and server-side conversation storage', () => {
    const body = buildResponsesRequestBody('m', messages())
    expect(body.stream).toBe(false)
    // store:false keeps audited source off the provider's retained state.
    expect(body.store).toBe(false)
  })
})

describe('successful text extraction', () => {
  it('reads the assistant text from output[].content[].output_text', async () => {
    const verdict = '{"verdict":"approved","summary":"ok"}'
    respondWith(okEnvelope(verdict))

    const result = await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })
    expect(result).toEqual({ ok: true, text: verdict })
  })

  it('skips reasoning items rather than reading output[0] positionally', async () => {
    // A deployment that emits a reasoning item first would otherwise have its
    // reasoning read as the verdict.
    respondWith({
      status: 'completed',
      output: [
        { type: 'reasoning', summary: ['thinking'] },
        { type: 'message', content: [{ type: 'output_text', text: 'ANSWER' }] }
      ]
    })
    const result = await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })
    expect(result).toEqual({ ok: true, text: 'ANSWER' })
  })

  it('concatenates multiple text parts', async () => {
    respondWith({
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: '{"verdict":' },
            { type: 'output_text', text: '"approved"}' }
          ]
        }
      ]
    })
    const result = await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })
    expect(result).toEqual({ ok: true, text: '{"verdict":"approved"}' })
  })

  it('accepts the output_text convenience field as a fallback', async () => {
    respondWith({ status: 'completed', output_text: 'FALLBACK' })
    const result = await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })
    expect(result).toEqual({ ok: true, text: 'FALLBACK' })
  })

  it('tolerates unknown envelope fields', async () => {
    // A provider adding a field must not turn a good verdict into malformed.
    respondWith({
      status: 'completed',
      usage: { input_tokens: 10 },
      service_tier: 'default',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK', logprobs: [] }] }]
    })
    const result = await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })
    expect(result).toEqual({ ok: true, text: 'OK' })
  })
})

describe('malformed responses fail closed', () => {
  it.each([
    ['a non-object body', '"just a string"'],
    ['an empty object', '{}'],
    ['output with no text parts', '{"status":"completed","output":[{"type":"reasoning"}]}'],
    ['a whitespace-only answer', '{"status":"completed","output_text":"   "}'],
    ['a chat/completions envelope', '{"choices":[{"message":{"content":"x"}}]}']
  ])('reports response_malformed for %s', async (_label, raw) => {
    setNoToolsFetchForTests(async () => new Response(raw, { status: 200 }))
    const result = await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })
    expect(result).toEqual({ ok: false, reasonCode: 'response_malformed' })
  })

  it('reports response_malformed for a non-JSON 200', async () => {
    setNoToolsFetchForTests(async () => new Response('<html>gateway</html>', { status: 200 }))
    const result = await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })
    expect(result).toEqual({ ok: false, reasonCode: 'response_malformed' })
  })
})

describe('HTTP and transport errors map to closed codes', () => {
  it.each([
    [401, 'api_unauthorized'],
    [403, 'api_unauthorized'],
    [429, 'api_rate_limited'],
    [413, 'context_limit_exceeded'],
    [500, 'api_unavailable'],
    [503, 'api_unavailable'],
    [400, 'response_malformed']
  ])('maps HTTP %i to %s', async (status, expected) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setNoToolsFetchForTests(async () => new Response('{}', { status }))

    const result = await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })
    expect(result).toEqual({ ok: false, reasonCode: expected })
  })

  it('maps an aborted request to api_timeout', async () => {
    setNoToolsFetchForTests(async (_url, init) => {
      // Reproduces what fetch does on an aborted signal.
      await new Promise((resolve) => setTimeout(resolve, 5))
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      void init
      throw error
    })

    const result = await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })
    expect(result).toEqual({ ok: false, reasonCode: 'api_timeout' })
  })

  it('actually aborts when the deadline elapses', async () => {
    setNoToolsFetchForTests(
      (_url, init) =>
        // Never resolves; only the abort signal settles it — which is what
        // proves the deadline is wired to the AbortController rather than
        // merely being passed around.
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })
    )

    const result = await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 10 })
    expect(result).toEqual({ ok: false, reasonCode: 'api_timeout' })
  })

  it('maps a network failure to api_unavailable', async () => {
    setNoToolsFetchForTests(async () => {
      throw new TypeError('fetch failed')
    })
    const result = await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })
    expect(result).toEqual({ ok: false, reasonCode: 'api_unavailable' })
  })
})

describe('context-limit conditions', () => {
  it('maps an incomplete response to context_limit_exceeded', async () => {
    // The Responses equivalent of finish_reason === 'length'. Reporting this as
    // unparseable would misattribute a length problem to the model's formatting.
    respondWith({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: []
    })
    const result = await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })
    expect(result).toEqual({ ok: false, reasonCode: 'context_limit_exceeded' })
  })

  it('maps a 200 error body naming the context window', async () => {
    respondWith({ error: { code: 'context_length_exceeded' } })
    const result = await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })
    expect(result).toEqual({ ok: false, reasonCode: 'context_limit_exceeded' })
  })

  it('maps a 200 error body naming a quota to api_rate_limited', async () => {
    respondWith({ error: { type: 'rate_limit_exceeded' } })
    const result = await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })
    expect(result).toEqual({ ok: false, reasonCode: 'api_rate_limited' })
  })

  it('maps an incomplete response with an unrelated reason to malformed', async () => {
    // A truncation Orca does not understand must not be reported as a context
    // problem the user could act on.
    respondWith({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } })
    const result = await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })
    expect(result).toEqual({ ok: false, reasonCode: 'response_malformed' })
  })
})

describe('no transport outcome carries an approval', () => {
  it('every failure arm returns ok:false with no text', async () => {
    const failures: [string, number][] = [
      ['unauthorized', 401],
      ['rate limited', 429],
      ['server error', 500],
      ['bad request', 400]
    ]
    vi.spyOn(console, 'error').mockImplementation(() => {})

    for (const [, status] of failures) {
      setNoToolsFetchForTests(
        async () => new Response(JSON.stringify(okEnvelope('{"verdict":"approved"}')), { status })
      )
      const result = await dispatchNoToolsTurn({ messages: messages(), timeoutMs: 5_000 })
      // Even though the BODY says approved, a non-2xx never yields text.
      expect(result.ok).toBe(false)
      expect(result).not.toHaveProperty('text')
    }
  })
})
