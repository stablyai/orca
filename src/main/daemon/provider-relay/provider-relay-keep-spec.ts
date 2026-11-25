import type { ProviderRelayKeepSpec } from '../protocol/daemon-provider-relay-protocol'

const MAX_KEEP_NAMES = 8
const MAX_KEEP_NAME_CHARS = 128

const keepNames = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_KEEP_NAMES &&
  value.every(
    (name) => typeof name === 'string' && name.length > 0 && name.length <= MAX_KEEP_NAME_CHARS
  )

/** Untrusted wire input; a malformed spec keeps nothing rather than refusing the launch. */
export function readProviderRelayKeepSpec(value: unknown): ProviderRelayKeepSpec | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const answers = 'answers' in value ? value.answers : undefined
  const lines = 'lines' in value ? value.lines : undefined
  const outstanding = 'outstanding' in value ? value.outstanding : undefined
  const requests = 'requests' in value ? value.requests : []
  if (!keepNames(answers) || !keepNames(lines) || !keepNames(outstanding) || !keepNames(requests)) {
    return null
  }
  return answers.length > 0 || lines.length > 0 || outstanding.length > 0 || requests.length > 0
    ? { answers, lines, outstanding, requests }
    : null
}
