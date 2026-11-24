import { assertJsonTextStructureWithinLimits } from '../../../shared/json-stream/json-text-structure-limit'

const CONTROL_JSON_LIMITS = { structuralTokens: 64 * 1024, nestingDepth: 16 } as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readClaudeControlResponses(
  stdout: string,
  settled?: (requestId: string) => void
): Map<string, unknown> {
  const responses = new Map<string, unknown>()
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('{') || !line.includes('request_id')) {
      continue
    }
    try {
      assertJsonTextStructureWithinLimits(line, CONTROL_JSON_LIMITS)
      const frame: unknown = JSON.parse(line)
      if (!isRecord(frame) || !isRecord(frame.response)) {
        continue
      }
      const response = frame.response
      if (
        (response.subtype === 'success' || response.subtype === 'error') &&
        typeof response.request_id === 'string'
      ) {
        settled?.(response.request_id)
      }
      if (response.subtype === 'success' && typeof response.request_id === 'string') {
        responses.set(response.request_id, response.response)
      }
    } catch {
      // Diagnostics and incomplete frames establish no control facts.
    }
  }
  return responses
}
