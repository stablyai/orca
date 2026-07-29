import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAiTriageProvider, parseTriageProviderOutput } from './triage-provider'

function chatCompletionResponse(contentJson: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(contentJson) } }] }),
    { status: 200 }
  )
}

const VALID_OUTPUT = {
  decision: 'direct',
  risk: 'low',
  rationale: 'Small, well-scoped change.',
  acceptanceCriteria: [{ id: 'ac1', text: 'Feature works as described', covered: false }],
  nextStepPrompt: 'Implement the feature described in the task.'
}

describe('parseTriageProviderOutput', () => {
  it('accepts a well-formed structured response', () => {
    const result = parseTriageProviderOutput(JSON.stringify(VALID_OUTPUT))
    expect(result).toEqual({ ok: true, output: VALID_OUTPUT })
  })

  it('rejects text that is not JSON', () => {
    expect(parseTriageProviderOutput('not json at all')).toEqual({
      ok: false,
      reasonCode: 'output_invalid'
    })
  })

  it('rejects JSON missing a required field', () => {
    const { decision: _decision, ...withoutDecision } = VALID_OUTPUT
    expect(parseTriageProviderOutput(JSON.stringify(withoutDecision))).toEqual({
      ok: false,
      reasonCode: 'output_invalid'
    })
  })

  it('rejects an invalid decision value', () => {
    expect(
      parseTriageProviderOutput(JSON.stringify({ ...VALID_OUTPUT, decision: 'maybe' }))
    ).toEqual({ ok: false, reasonCode: 'output_invalid' })
  })

  it('rejects an invalid risk value', () => {
    expect(
      parseTriageProviderOutput(JSON.stringify({ ...VALID_OUTPUT, risk: 'catastrophic' }))
    ).toEqual({ ok: false, reasonCode: 'output_invalid' })
  })

  it('rejects an empty acceptanceCriteria array', () => {
    expect(
      parseTriageProviderOutput(JSON.stringify({ ...VALID_OUTPUT, acceptanceCriteria: [] }))
    ).toEqual({ ok: false, reasonCode: 'output_invalid' })
  })

  it('rejects an acceptance criterion with covered=true (must always start false)', () => {
    expect(
      parseTriageProviderOutput(
        JSON.stringify({
          ...VALID_OUTPUT,
          acceptanceCriteria: [{ id: 'ac1', text: 'x', covered: true }]
        })
      )
    ).toEqual({ ok: false, reasonCode: 'output_invalid' })
  })

  it('rejects an unknown extra top-level key (strict schema)', () => {
    expect(parseTriageProviderOutput(JSON.stringify({ ...VALID_OUTPUT, extra: 'field' }))).toEqual({
      ok: false,
      reasonCode: 'output_invalid'
    })
  })

  it('rejects an empty rationale', () => {
    expect(parseTriageProviderOutput(JSON.stringify({ ...VALID_OUTPUT, rationale: '' }))).toEqual({
      ok: false,
      reasonCode: 'output_invalid'
    })
  })

  it('rejects an oversized rationale', () => {
    expect(
      parseTriageProviderOutput(JSON.stringify({ ...VALID_OUTPUT, rationale: 'x'.repeat(5000) }))
    ).toEqual({ ok: false, reasonCode: 'output_invalid' })
  })
})

describe('createOpenAiTriageProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns provider_unavailable when getApiKey throws (no key configured)', async () => {
    const fetchImpl = vi.fn()
    const provider = createOpenAiTriageProvider({
      getApiKey: () => {
        throw new Error('OpenAI API key is not configured')
      },
      fetchImpl
    })

    const result = await provider.runTriage({ title: 'T', description: 'D' })

    expect(result).toEqual({ ok: false, reasonCode: 'provider_unavailable' })
    // No network call is ever attempted without a key.
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns provider_unavailable for an empty/blank key', async () => {
    const fetchImpl = vi.fn()
    const provider = createOpenAiTriageProvider({ getApiKey: () => '   ', fetchImpl })

    const result = await provider.runTriage({ title: 'T', description: 'D' })

    expect(result).toEqual({ ok: false, reasonCode: 'provider_unavailable' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('parses a successful response into validated structured output', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatCompletionResponse(VALID_OUTPUT))
    const provider = createOpenAiTriageProvider({ getApiKey: () => 'sk-test-key', fetchImpl })

    const result = await provider.runTriage({ title: 'T', description: 'D' })

    expect(result).toEqual({ ok: true, output: VALID_OUTPUT })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-key')
  })

  it('returns provider_timeout when the request aborts (AbortError), without leaking the error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const abortError = new DOMException('The operation was aborted', 'AbortError')
    const fetchImpl = vi.fn().mockRejectedValue(abortError)
    const provider = createOpenAiTriageProvider({
      getApiKey: () => 'sk-test-key',
      fetchImpl,
      timeoutMs: 5
    })

    const result = await provider.runTriage({ title: 'T', description: 'D' })

    expect(result).toEqual({ ok: false, reasonCode: 'provider_timeout' })
    expect(consoleErrorSpy).toHaveBeenCalled()
  })

  it('returns provider_error for a generic network failure, and the thrown error never reaches the result', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sensitiveError = new Error(
      'connect ECONNREFUSED 10.0.0.5:443 while calling https://api.openai.com/v1/chat/completions with key sk-abcdef123456'
    )
    const fetchImpl = vi.fn().mockRejectedValue(sensitiveError)
    const provider = createOpenAiTriageProvider({ getApiKey: () => 'sk-test-key', fetchImpl })

    const result = await provider.runTriage({ title: 'T', description: 'D' })

    expect(result).toEqual({ ok: false, reasonCode: 'provider_error' })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('ECONNREFUSED')
    expect(serialized).not.toContain('10.0.0.5')
    expect(serialized).not.toContain('sk-abcdef123456')
    // Diagnostics remain available locally via console.error only.
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.any(String), sensitiveError)
  })

  it('returns provider_unavailable on HTTP 401 (bad/revoked key), not provider_error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 }))
    const provider = createOpenAiTriageProvider({ getApiKey: () => 'sk-bad-key', fetchImpl })

    const result = await provider.runTriage({ title: 'T', description: 'D' })

    expect(result).toEqual({ ok: false, reasonCode: 'provider_unavailable' })
    expect(consoleErrorSpy).toHaveBeenCalled()
  })

  it('returns provider_error on a non-auth HTTP failure (e.g. 500)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('Internal Server Error', { status: 500 }))
    const provider = createOpenAiTriageProvider({ getApiKey: () => 'sk-test-key', fetchImpl })

    const result = await provider.runTriage({ title: 'T', description: 'D' })

    expect(result).toEqual({ ok: false, reasonCode: 'provider_error' })
  })

  it('returns output_invalid when the HTTP response body is not a valid chat-completion envelope', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ unexpected: true }), { status: 200 }))
    const provider = createOpenAiTriageProvider({ getApiKey: () => 'sk-test-key', fetchImpl })

    const result = await provider.runTriage({ title: 'T', description: 'D' })

    expect(result).toEqual({ ok: false, reasonCode: 'output_invalid' })
  })

  it('returns output_invalid when the message content is not valid JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), {
        status: 200
      })
    )
    const provider = createOpenAiTriageProvider({ getApiKey: () => 'sk-test-key', fetchImpl })

    const result = await provider.runTriage({ title: 'T', description: 'D' })

    expect(result).toEqual({ ok: false, reasonCode: 'output_invalid' })
  })

  it('never makes a real network request — fetchImpl is always the injected fake', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chatCompletionResponse(VALID_OUTPUT))
    const globalFetchSpy = vi.spyOn(globalThis, 'fetch')
    const provider = createOpenAiTriageProvider({ getApiKey: () => 'sk-test-key', fetchImpl })

    await provider.runTriage({ title: 'T', description: 'D' })

    expect(globalFetchSpy).not.toHaveBeenCalled()
  })
})
