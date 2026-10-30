import type { RpcResponse } from '../transport/types'

// Only missing permits a destructive route bounce; ambiguous/transient failures remain unknown.
export type WorktreeShowResolution = 'present' | 'missing' | 'unknown'

const NOT_FOUND_CODE = 'selector_not_found'

// Older desktops wrap missing selectors in runtime_error; require an exact terminal token with a real boundary.
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
  // Wrapped tokens are authoritative only with runtime_error, never arbitrary codes with matching prose.
  if (response.error.code !== 'runtime_error') {
    return 'unknown'
  }
  return endsWithNotFoundToken(response.error.message) ? 'missing' : 'unknown'
}
