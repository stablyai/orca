import type { ProviderRelayKeepSpec } from '../protocol/daemon-provider-relay-protocol'

const MAX_KEEP_NAMES = 8
const MAX_KEEP_NAME_CHARS = 128

const keepNames = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_KEEP_NAMES &&
  value.every(
    (name) => typeof name === 'string' && name.length > 0 && name.length <= MAX_KEEP_NAME_CHARS
  )

const MAX_REPLY_CHARS = 4096
/** A request that asks the person (a permission, an approval, a question, a plan to accept) is
 *  never answered for them: the daemon holds it for the app, whatever a spec says. */
const ASKS_THE_PERSON =
  /permission|approv|elicit|question|confirm|plan_mode|(?:^|[/_.])ask(?:[/_.]|$)|ask_?user/i

/** Fixed answers by method; a malformed, oversized or person-asking set answers nothing itself. */
function readReplies(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const entries = Object.entries(value)
  return keepNames(entries.map(([method]) => method)) &&
    !entries.some(([method]) => ASKS_THE_PERSON.test(method)) &&
    entries.every(([, reply]) => (JSON.stringify(reply)?.length ?? Infinity) <= MAX_REPLY_CHARS)
    ? Object.fromEntries(entries)
    : undefined
}

/** Untrusted wire input; a malformed spec keeps nothing rather than refusing the launch. */
export function readProviderRelayKeepSpec(value: unknown): ProviderRelayKeepSpec | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const answers = 'answers' in value ? value.answers : undefined
  const lines = 'lines' in value ? value.lines : undefined
  const outstanding = 'outstanding' in value ? value.outstanding : undefined
  const requests = 'requests' in value ? value.requests : []
  const replies = 'replies' in value ? readReplies(value.replies) : undefined
  if (!keepNames(answers) || !keepNames(lines) || !keepNames(outstanding) || !keepNames(requests)) {
    return null
  }
  const named = [answers, lines, outstanding, requests, Object.keys(replies ?? {})]
  return named.some((names) => names.length > 0)
    ? { answers, lines, outstanding, requests, ...(replies ? { replies } : {}) }
    : null
}
