import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { providerFailureMessage } from './text-subscription-request'

export function parseClaudeSubscriptionOutput(stdout: string, code: number | null) {
  let refused = false
  let otherFailure = false
  let answer = false
  let result: Record<string, unknown> | undefined
  try {
    for (const line of stdout.split(/\r?\n/).filter((line) => line.trim())) {
      assertJsonTextStructureWithinLimits(line, { structuralTokens: 65536, nestingDepth: 32 })
      const frame: Record<string, unknown> = JSON.parse(line)
      if (frame.type === 'assistant' && frame.parent_tool_use_id == null) {
        if (frame.api_error === 'usage_limit_reached' && frame.error === 'rate_limit') {
          refused = true
        } else if (frame.error || frame.api_error) {
          otherFailure = true
        } else {
          answer = true
        }
      }
      if (frame.type === 'result') {
        if (result) {
          return { ok: false as const, quota: false }
        }
        result = frame
      }
    }
  } catch {
    return { ok: false as const, quota: false }
  }
  if (
    code === 0 &&
    result?.is_error === false &&
    result.subtype === 'success' &&
    typeof result.result === 'string'
  ) {
    return { ok: true as const, text: result.result }
  }
  return {
    ok: false as const,
    message: result?.is_error === true ? providerFailureMessage(result.result) : undefined,
    quota:
      code !== null &&
      code !== 0 &&
      refused &&
      !otherFailure &&
      !answer &&
      result?.is_error === true
  }
}
