// The no-tools system prompt and the mediated-retrieval request schema.
//
// THE PROMPT IS NOT A SECURITY BOUNDARY. A model may ignore every instruction
// here. What actually contains this adapter is structural and lives elsewhere:
// no `tools` key in the request (audited-no-tools-transport.ts), so there is
// nothing to call; path validation before any read (audited-no-tools-scope.ts);
// and hard byte caps (audited-no-tools-bundle.ts). The prompt's job is to make
// the CORRECT behaviour easy, not to make the incorrect one impossible.
import { z } from 'zod'
import { NO_TOOLS_LIMITS } from '../../shared/audited-audit-mode-types'
import { REVIEW_VERDICTS } from '../../shared/audited-workflow-types'

/**
 * The system prompt.
 *
 * States the no-tools reality plainly rather than pretending the model has a
 * workspace: a model told it can "read the repository" will emit tool calls that
 * this transport cannot carry, producing an unparseable verdict instead of a
 * useful one.
 */
export function buildNoToolsSystemPrompt(): string {
  return [
    'You are a code auditor operating in a RESTRICTED, NO-TOOLS mode.',
    '',
    'You have NO tools. You cannot run commands, read files, browse the web,',
    'call functions, or access a shell, a filesystem, or a network. Everything',
    'you are permitted to see has already been provided in the user message.',
    '',
    'Do not claim to have run, tested, executed, or verified anything. You have',
    'read the supplied material and nothing else. If your confidence is limited',
    'by what you were given, say so in your summary rather than assuming.',
    '',
    // THE REQUEST AFFORDANCE IS NOT OFFERED. Mediated retrieval is disabled for
    // the first release, so advertising it would invite a reply that can only
    // end the audit. Telling the model to work with what it has is the honest
    // instruction for the shipped configuration.
    'You cannot request additional files. Judge the work using only what is',
    'provided below. If something essential is missing, say so in your summary',
    'and choose a verdict other than "approved".',
    '',
    '## Final answer',
    'When you are ready to judge, your FINAL message must be exactly one JSON',
    'object and nothing else:',
    `{"verdict":"${REVIEW_VERDICTS.join('|')}","summary":"<one paragraph>","coverage":[{"id":"<criterion id>","covered":true|false,"note":"<at most one sentence>"}],"findings":[{"severity":"low|medium|high","text":"<finding>"}]}`,
    '',
    'Include one coverage entry per acceptance criterion, using the exact ids shown.',
    'Mark a criterion covered only if the work actually addresses it.',
    '',
    'Use "approved" only if the work is correct and safe as written.',
    'Use "fixes_requested" if it needs changes you can describe.',
    'Use "blocked" if it cannot proceed at all.',
    'Do not use any other verdict value.'
  ].join('\n')
}

// `.strict()` so a request carrying an extra key — a stray "path", "glob", or
// "command" a model invented — is REJECTED rather than stripped and honoured in
// part. An unexpected key means the model is not following this protocol, and
// proceeding on the recognized half of a misunderstood request is exactly the
// kind of partial compliance that turns into a leak.
const ContextRequestSchema = z
  .object({
    needFiles: z.array(z.string()).min(1).max(NO_TOOLS_LIMITS.maxRequestedFiles),
    reason: z.string().max(500).optional()
  })
  .strict()

export type ParsedContextRequest = { needFiles: readonly string[] }

/**
 * Detects a mediated-retrieval request in the model's reply.
 *
 * STILL CALLED WHILE RETRIEVAL IS DISABLED, and deliberately so: the adapter
 * needs to DETECT the request in order to refuse it explicitly rather than let
 * a `{"needFiles":[...]}` reply fall through to the verdict parser and be
 * reported as unparseable. Detection is not service — see
 * MEDIATED_RETRIEVAL_ENABLED, which is what stops the request being served.
 *
 * Returns null when the text is NOT a context request — including when it is
 * malformed. That is deliberate: an unrecognized reply falls through to verdict
 * parsing, which fails closed on its own. Treating "not a valid request" as "a
 * request" here would convert every unparseable verdict into a retrieval error
 * and lose the more accurate diagnosis.
 */
export function parseContextRequest(text: string): ParsedContextRequest | null {
  const trimmed = text.trim()
  // Cheap pre-check: skip JSON parsing entirely for the overwhelmingly common
  // case of a verdict object, which never contains this key.
  if (!trimmed.includes('needFiles')) {
    return null
  }

  for (const candidate of findJsonObjects(trimmed)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const validated = ContextRequestSchema.safeParse(parsed)
    if (validated.success) {
      return { needFiles: validated.data.needFiles }
    }
  }
  return null
}

/**
 * Returns balanced top-level `{...}` substrings, last first.
 *
 * Duplicated in spirit from audited-plan-audit-verdict.ts's findJsonCandidates
 * rather than shared, because that one is part of the VERDICT contract: making
 * it a common utility would couple two fail-closed parsers whose acceptance
 * rules are allowed to diverge. Brace counting is string-aware for the same
 * reason there — a `}` inside a quoted path must not close the object early.
 */
function findJsonObjects(text: string): string[] {
  const objects: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) {
        start = index
      }
      depth += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, index + 1))
        start = -1
      }
      if (depth < 0) {
        depth = 0
      }
    }
  }
  return objects.toReversed()
}
