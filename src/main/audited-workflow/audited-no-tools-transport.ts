// The ONE module that reads the provider key and sets an Authorization header.
// MAIN PROCESS ONLY.
//
// audited-no-tools-boundary.test.ts asserts this file is the sole importer of
// readAuditedCodexProviderKey anywhere outside that key store's own tests. That
// assertion is the security property: a second reader could appear in a diff
// that looks harmless, and the boundary test is what makes adding one a
// deliberate, reviewable act.
//
// THE KEY'S LIFETIME IS ONE FUNCTION CALL. It is read inside dispatch, placed
// directly into a header object, and dropped when the call returns. It is never
// stored on a module variable, returned, embedded in a template literal, put in
// an Error message, or passed to anything that could log it. The header object
// itself is never spread into a diagnostic, and NO request or response body is
// ever logged — only closed reason codes leave this module.
//
// WHAT THIS IS NOT: credential DELIVERY. No child process is spawned, no env var
// is set, and AUDITED_CODEX_CREDENTIAL_DELIVERY_ENABLED is neither read nor
// changed. The key goes from safeStorage to an HTTPS request header in the same
// process, and nowhere else. Tranche 2 remains closed.
//
// ── WIRE PROTOCOL: OpenAI RESPONSES API, NOT CHAT COMPLETIONS ──────────────
//
// The registry declares `wireApi: 'responses'`, and that declaration is not
// decorative: audited-codex-launch-plan.ts passes the SAME value to Codex as
// `model_providers.<id>.wire_api`, so the CLI path and this adapter address one
// provider over one protocol. Speaking chat/completions here would mean Orca
// used two different protocols for the same endpoint depending on which
// transport ran — and would 404 against a Responses-only deployment.
//
// The concrete differences from chat/completions, all load-bearing:
//   POST <baseUrl>/responses          not /chat/completions
//   instructions: <system text>       not a role:'system' message
//   input: [{role, content:[{type:'input_text'|'output_text', text}]}]
//                                     not messages:[{role, content:<string>}]
//   max_output_tokens                 not max_tokens
//   output[].content[].type==='output_text'
//                                     not choices[0].message.content
//   incomplete_details.reason         not finish_reason
import { z } from 'zod'
import { NO_TOOLS_LIMITS, type NoToolsReasonCode } from '../../shared/audited-audit-mode-types'
import { readAuditedCodexProviderKey } from './audited-codex-provider-key-store'
import { getSoleAuditedCodexProvider } from './audited-codex-provider-registry'

export type NoToolsTransportResult =
  | { ok: true; text: string }
  | { ok: false; reasonCode: NoToolsReasonCode }

/**
 * One turn's worth of conversation. Assembled entirely in main.
 *
 * `system` is carried as a role here and mapped to the Responses
 * `instructions` field at request time — the caller should not have to know
 * which protocol field a system prompt lands in.
 */
export type NoToolsMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type NoToolsDispatchArgs = {
  messages: readonly NoToolsMessage[]
  /** Remaining wall clock for the WHOLE audit, not just this turn. */
  timeoutMs: number
}

// Test seam: lets suites drive every transport outcome deterministically without
// a network or a key. Mirrors setAuditedCodexRunnerForTests.
type Dispatcher = (args: NoToolsDispatchArgs) => Promise<NoToolsTransportResult>
let dispatcherOverride: Dispatcher | undefined

export function setNoToolsDispatcherForTests(dispatcher: Dispatcher | undefined): void {
  dispatcherOverride = dispatcher
}

// Injectable fetch, for CONTRACT tests that assert the real request shape. A
// suite that overrode the dispatcher would bypass the very code under test, so
// the wire-format cases replace fetch instead and let this module build the
// request exactly as production does.
let fetchOverride: typeof fetch | undefined

export function setNoToolsFetchForTests(impl: typeof fetch | undefined): void {
  fetchOverride = impl
}

/** The Responses endpoint, derived from the registry's immutable base URL. */
export function buildResponsesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/responses`
}

/**
 * Builds the Responses request body.
 *
 * EXPORTED FOR CONTRACT TESTS so the wire shape can be asserted without a
 * network. Pure: it reads no key, touches no I/O, and is safe to call in any
 * context — the credential enters only in buildAuthorizedHeaders.
 */
export function buildResponsesRequestBody(
  model: string,
  messages: readonly NoToolsMessage[]
): Record<string, unknown> {
  // The system prompt becomes `instructions`. Responses has no 'system' role in
  // `input`; sending one is silently ignored by some deployments and rejected by
  // others, either of which would strip the no-tools contract from the request.
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')

  const input = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role,
      content: [
        {
          // The part type is role-dependent and NOT interchangeable: an
          // assistant turn replayed as `input_text` is rejected as a malformed
          // item, which would turn a legal follow-up into a 400.
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: message.content
        }
      ]
    }))

  return {
    model,
    ...(instructions.length > 0 ? { instructions } : {}),
    input,
    // NO `tools`, NO `tool_choice`, NO `functions`. Their ABSENCE is the
    // no-tools property: the model has no callable surface, so it cannot reach
    // a shell, the filesystem, MCP, a subprocess, or the network. The
    // request-shape test asserts these keys never appear.
    max_output_tokens: NO_TOOLS_LIMITS.maxOutputTokens,
    // Deterministic-leaning: an audit verdict should not vary run to run more
    // than the model inherently does.
    temperature: 0,
    // Streaming would require incremental parsing of a model-influenced stream
    // for no benefit — the verdict is only usable complete.
    stream: false,
    // Server-side conversation state is opt-in on Responses. Orca sends the full
    // bundle every turn, so persistence would retain audited source on the
    // provider with nothing gained.
    store: false
  }
}

/**
 * Sends one bounded turn and returns the model's message text.
 *
 * Never rejects: every failure is a closed reason code, because a rejection here
 * would strand a `running` audit row exactly as it would in runCodexProcess.
 */
export async function dispatchNoToolsTurn(
  args: NoToolsDispatchArgs
): Promise<NoToolsTransportResult> {
  if (dispatcherOverride) {
    return dispatcherOverride(args)
  }

  const provider = getSoleAuditedCodexProvider()

  // The endpoint is a CODE CONSTANT from the registry. Never settings-derived,
  // never renderer-supplied — a caller-chosen base URL combined with a
  // main-read credential would be an exfiltration primitive.
  const url = buildResponsesUrl(provider.baseUrl)
  if (!url.startsWith('https://')) {
    // Unreachable with the current registry; asserted so a future entry cannot
    // silently downgrade the transport to cleartext.
    return { ok: false, reasonCode: 'api_unavailable' }
  }

  const body = JSON.stringify(buildResponsesRequestBody(provider.defaultModel, args.messages))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeoutMs)
  const fetchImpl = fetchOverride ?? globalThis.fetch

  try {
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: buildAuthorizedHeaders(),
        body,
        signal: controller.signal,
        redirect: 'error'
      })
    } catch (error) {
      // The key cannot appear here — a fetch error carries the URL and a syscall
      // code, never the request headers — but the error is still classified
      // rather than logged raw, so a future provider's richer error object
      // cannot become a leak.
      return { ok: false, reasonCode: classifyFetchError(error) }
    }

    if (!response.ok) {
      // The STATUS ONLY. A non-2xx body frequently echoes the request, and on
      // some gateways the offending header — logging it would defeat every other
      // precaution in this module.
      console.error(`[auditedWorkflow] Audit provider returned HTTP ${response.status}.`)
      return { ok: false, reasonCode: classifyHttpStatus(response.status) }
    }

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      return { ok: false, reasonCode: 'response_malformed' }
    }

    return extractResponsesText(parsed)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Builds the request headers, reading the key at the last possible moment.
 *
 * Returns a fresh object each call so no long-lived structure holds the secret.
 * A read failure is deliberately indistinguishable in the returned VALUE from a
 * missing key — both throw here and are classified as `api_unauthorized` by the
 * caller — because the reason the key is unusable is not worth a second code
 * that would need the value inspected to choose between them.
 */
function buildAuthorizedHeaders(): Record<string, string> {
  return {
    // The ONE use of the secret in the entire codebase.
    Authorization: `Bearer ${readAuditedCodexProviderKey()}`,
    'Content-Type': 'application/json'
  }
}

function classifyFetchError(error: unknown): NoToolsReasonCode {
  if (error instanceof Error && error.name === 'AbortError') {
    return 'api_timeout'
  }
  // A key that cannot be read or decrypted surfaces as a throw from
  // buildAuthorizedHeaders, which lands here. The credential is unusable, which
  // is exactly what api_unauthorized means to the user.
  if (error instanceof Error && /API key/i.test(error.message)) {
    return 'api_unauthorized'
  }
  return 'api_unavailable'
}

function classifyHttpStatus(status: number): NoToolsReasonCode {
  if (status === 401 || status === 403) {
    return 'api_unauthorized'
  }
  if (status === 429) {
    return 'api_rate_limited'
  }
  // Some deployments report an over-long prompt as 413 rather than a typed
  // error body.
  if (status === 413) {
    return 'context_limit_exceeded'
  }
  if (status >= 500) {
    return 'api_unavailable'
  }
  // Every other 4xx is a request this client built, so it is a protocol defect
  // rather than a transient condition — and must not be retryable.
  return 'response_malformed'
}

// The Responses envelope, narrowed to exactly the fields this adapter reads.
//
// `.passthrough()` at each level: a provider may add fields, and rejecting an
// unknown key would turn a perfectly good verdict into `response_malformed`.
// The STRICTNESS THAT MATTERS is on the fields actually consumed — a content
// part must carry `type` and a string `text`, or it is not usable text.
const ResponsesEnvelopeSchema = z
  .object({
    status: z.string().optional(),
    incomplete_details: z.object({ reason: z.string().optional() }).passthrough().optional(),
    error: z
      .object({ code: z.unknown().optional(), type: z.unknown().optional() })
      .passthrough()
      .optional(),
    // The convenience field some deployments emit alongside `output`. Read as a
    // fallback only — `output` is the authoritative shape.
    output_text: z.string().optional(),
    output: z
      .array(
        z
          .object({
            type: z.string().optional(),
            content: z
              .array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
              .optional()
          })
          .passthrough()
      )
      .optional()
  })
  .passthrough()

/**
 * Pulls the assistant text out of the Responses envelope.
 *
 * FAIL-CLOSED: any shape that is not exactly "a non-empty assistant text" is
 * `response_malformed`. There is no input to this function that yields a
 * verdict — the caller must still parse the text through the shared verdict
 * schema, which fails closed in turn.
 */
function extractResponsesText(parsed: unknown): NoToolsTransportResult {
  const envelope = ResponsesEnvelopeSchema.safeParse(parsed)
  if (!envelope.success) {
    return { ok: false, reasonCode: 'response_malformed' }
  }
  const data = envelope.data

  // A 200 carrying an error object. Deployments do this for context overflow.
  if (data.error) {
    const code = String(data.error.code ?? data.error.type ?? '')
    if (/context|token|length/i.test(code)) {
      return { ok: false, reasonCode: 'context_limit_exceeded' }
    }
    if (/rate|quota/i.test(code)) {
      return { ok: false, reasonCode: 'api_rate_limited' }
    }
    return { ok: false, reasonCode: 'response_malformed' }
  }

  // THE RESPONSES EQUIVALENT OF finish_reason==='length'. A truncated reply
  // cannot contain a complete verdict object, so it is reported as a context
  // failure rather than left to fail as unparseable — which would misattribute
  // a length problem to the model's formatting.
  if (data.status === 'incomplete' || data.incomplete_details?.reason) {
    const reason = data.incomplete_details?.reason ?? ''
    return {
      ok: false,
      reasonCode: /token|length/i.test(reason) ? 'context_limit_exceeded' : 'response_malformed'
    }
  }

  const text = collectOutputText(data.output) || (data.output_text ?? '')
  if (text.trim().length === 0) {
    return { ok: false, reasonCode: 'response_malformed' }
  }
  return { ok: true, text }
}

/**
 * Concatenates every `output_text` part across every message item.
 *
 * Reasoning items (`type: 'reasoning'`) carry no `output_text` part and are
 * skipped naturally by the type filter rather than by position — indexing
 * `output[0]` would read a reasoning item as the answer on any deployment that
 * emits one first.
 */
function collectOutputText(
  output: { content?: { type: string; text?: string }[] }[] | undefined
): string {
  if (!output) {
    return ''
  }
  const parts: string[] = []
  for (const item of output) {
    for (const part of item.content ?? []) {
      if (part.type === 'output_text' && typeof part.text === 'string') {
        parts.push(part.text)
      }
    }
  }
  return parts.join('')
}
