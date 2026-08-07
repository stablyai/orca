import type { RpcResponse } from '../transport/types'

// What a `worktree.show` answer proves about the target still existing on the host.
// 'unknown' is the safe verdict: every transient failure lands there, so a caller may
// only act destructively (bounce the route) on 'missing'.
export type WorktreeShowResolution = 'present' | 'missing' | 'unknown'

const NOT_FOUND_CODE = 'selector_not_found'

// Why: older desktops predate the passthrough allowlist and answer a missing selector as
// runtime_error carrying the token as its whole message, so the code alone under-detects.
// The token must end the message after a real boundary — prose that merely trails off in
// it ("…a prior selector_not_found diagnostic") is not a not-found answer.
const CODE_TOKEN_BOUNDARY = /(?:: |\n)[ \t]*$/

function endsWithNotFoundToken(message: string): boolean {
  const trimmed = message.trimEnd()
  if (!trimmed.endsWith(NOT_FOUND_CODE)) {
    return false
  }
  const prefix = trimmed.slice(0, -NOT_FOUND_CODE.length)
  return prefix.trim() === '' || CODE_TOKEN_BOUNDARY.test(prefix)
}

export function classifyWorktreeShowResponse(response: RpcResponse): WorktreeShowResolution {
  if (response.ok) {
    return 'present'
  }
  if (response.error.code === NOT_FOUND_CODE) {
    return 'missing'
  }
  // Why: the wrapped-token form only ever ships as runtime_error; any other code
  // whose message trails off in the token proves nothing about the worktree.
  if (response.error.code !== 'runtime_error') {
    return 'unknown'
  }
  return endsWithNotFoundToken(response.error.message) ? 'missing' : 'unknown'
}
