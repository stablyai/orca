// Injectable triage provider boundary (Phase 2). `TriageProvider` is the seam
// tests replace with a deterministic fake — no test in this feature ever
// makes a network request. `createOpenAiTriageProvider` is the real
// implementation, invoked only from audited-task-service.ts.
import { z } from 'zod'
import { RISK_LEVELS, TRIAGE_DECISIONS } from '../../shared/audited-workflow-types'
import type {
  AuditedAcceptanceCriterion,
  RiskLevel,
  TriageDecision
} from '../../shared/audited-workflow-types'

export type TriageProviderInput = {
  title: string
  description: string
}

export type TriageProviderOutput = {
  decision: TriageDecision
  risk: RiskLevel
  rationale: string
  acceptanceCriteria: AuditedAcceptanceCriterion[]
  nextStepPrompt: string
}

// Why: 'output_invalid' covers both "provider returned text that isn't JSON"
// and "JSON that doesn't satisfy the schema" — the caller never needs to
// distinguish a malformed response from a well-formed-but-wrong one, and
// neither case should leak the raw response body to the renderer.
export type TriageProviderResult =
  | { ok: true; output: TriageProviderOutput }
  | {
      ok: false
      reasonCode: 'provider_unavailable' | 'provider_timeout' | 'provider_error' | 'output_invalid'
    }

export type TriageProvider = {
  runTriage(input: TriageProviderInput): Promise<TriageProviderResult>
}

// Strict structured-output schema: unknown/extra keys rejected, every field
// required, acceptance criteria and prompt bounded so a pathological response
// can't be persisted as an unbounded blob.
const TriageOutputSchema = z
  .object({
    decision: z.enum(TRIAGE_DECISIONS),
    risk: z.enum(RISK_LEVELS),
    rationale: z.string().trim().min(1).max(4000),
    acceptanceCriteria: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(64),
            text: z.string().trim().min(1).max(500),
            covered: z.literal(false)
          })
          .strict()
      )
      .min(1)
      .max(20),
    nextStepPrompt: z.string().trim().min(1).max(8000)
  })
  .strict()

export function parseTriageProviderOutput(rawJsonText: string): TriageProviderResult {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawJsonText)
  } catch {
    return { ok: false, reasonCode: 'output_invalid' }
  }

  const validation = TriageOutputSchema.safeParse(parsedJson)
  if (!validation.success) {
    return { ok: false, reasonCode: 'output_invalid' }
  }

  return { ok: true, output: validation.data }
}

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions'
// Why: not surfaced as user-configurable settings in this phase (out of
// scope per the task); overridable via env for internal testing/rollout
// without a code change, and isolated to this one constant so a future
// settings-driven override has exactly one place to plug in.
const DEFAULT_TRIAGE_MODEL = process.env.ORCA_AUDITED_TRIAGE_MODEL?.trim() || 'gpt-4o-mini'
const TRIAGE_REQUEST_TIMEOUT_MS = 60_000

const TRIAGE_SYSTEM_PROMPT = `You are the triage step of an audited software development workflow. Given a task title and description, decide whether it requires a written implementation plan before coding ("plan") or can be implemented directly ("direct"). Respond with ONLY a single JSON object matching this exact shape, no prose, no markdown fences:
{"decision":"plan"|"direct","risk":"low"|"medium"|"high","rationale":"<concise reason>","acceptanceCriteria":[{"id":"<short id>","text":"<criterion>","covered":false}],"nextStepPrompt":"<a complete, self-contained prompt a Claude coding agent can use to execute the next step>"}`

export type CreateOpenAiTriageProviderOptions = {
  getApiKey: () => string
  fetchImpl?: typeof fetch
  model?: string
  timeoutMs?: number
}

/**
 * Real ChatGPT-backed triage provider. `getApiKey` is called lazily at
 * request time (never cached at construction) so an unconfigured key is
 * detected per-call rather than baked into a long-lived singleton; it may
 * throw, which this function treats identically to "no key" —
 * `provider_unavailable`, never the thrown message.
 */
export function createOpenAiTriageProvider(
  options: CreateOpenAiTriageProviderOptions
): TriageProvider {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const model = options.model ?? DEFAULT_TRIAGE_MODEL
  const timeoutMs = options.timeoutMs ?? TRIAGE_REQUEST_TIMEOUT_MS

  return {
    async runTriage(input: TriageProviderInput): Promise<TriageProviderResult> {
      let apiKey: string
      try {
        apiKey = options.getApiKey()
      } catch {
        return { ok: false, reasonCode: 'provider_unavailable' }
      }
      if (!apiKey || apiKey.trim() === '') {
        return { ok: false, reasonCode: 'provider_unavailable' }
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      let response: Response
      try {
        response = await fetchImpl(OPENAI_CHAT_COMPLETIONS_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: TRIAGE_SYSTEM_PROMPT },
              {
                role: 'user',
                content: `Title: ${input.title}\n\nDescription:\n${input.description}`
              }
            ]
          }),
          signal: controller.signal
        })
      } catch (error) {
        // Why: fetch rejects with an AbortError on timeout and with a generic
        // network error otherwise — neither the error object nor its message
        // (which may embed the URL or a DNS/proxy detail) ever leaves this
        // function; only the closed reason code does. Diagnostics stay local.
        const isAbort = error instanceof Error && error.name === 'AbortError'
        console.error('[auditedWorkflow] Triage provider request failed:', error)
        return { ok: false, reasonCode: isAbort ? 'provider_timeout' : 'provider_error' }
      } finally {
        clearTimeout(timeout)
      }

      if (!response.ok) {
        console.error(
          `[auditedWorkflow] Triage provider returned HTTP ${response.status} ${response.statusText}`
        )
        return {
          ok: false,
          reasonCode:
            response.status === 401 || response.status === 403
              ? 'provider_unavailable'
              : 'provider_error'
        }
      }

      let bodyJson: unknown
      try {
        bodyJson = await response.json()
      } catch (error) {
        console.error('[auditedWorkflow] Triage provider returned unparseable JSON body:', error)
        return { ok: false, reasonCode: 'provider_error' }
      }

      const content = extractChatCompletionContent(bodyJson)
      if (content === null) {
        return { ok: false, reasonCode: 'output_invalid' }
      }

      return parseTriageProviderOutput(content)
    }
  }
}

const ChatCompletionEnvelopeSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() })
      })
    )
    .min(1)
})

function extractChatCompletionContent(bodyJson: unknown): string | null {
  const parsed = ChatCompletionEnvelopeSchema.safeParse(bodyJson)
  if (!parsed.success) {
    return null
  }
  return parsed.data.choices[0].message.content
}
