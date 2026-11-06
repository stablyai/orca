import { parseOpenCodeGenerationOutput } from '../../shared/opencode-generation-output'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { providerFailureMessage } from './text-subscription-request'

function isQuotaErrorBody(responseBody: unknown): boolean {
  if (typeof responseBody !== 'string') {
    return false
  }
  try {
    assertJsonTextStructureWithinLimits(responseBody, { structuralTokens: 65536, nestingDepth: 32 })
    return JSON.parse(responseBody)?.error?.type === 'QuotaError'
  } catch {
    return false
  }
}

export function parseOpenCodeSubscriptionOutput(stdout: string, code: number | null) {
  const normal = parseOpenCodeGenerationOutput(stdout)
  if (code === 0 && normal.ok) {
    return { ok: true as const, text: normal.text }
  }
  let quota = false
  let answer = false
  let other = false
  let message: string | undefined
  try {
    for (const line of stdout.split(/\r?\n/).filter((line) => line.trim())) {
      assertJsonTextStructureWithinLimits(line, { structuralTokens: 65536, nestingDepth: 32 })
      const frame = JSON.parse(line)
      if (!['step_start', 'step_finish', 'reasoning', 'text', 'error'].includes(frame.type)) {
        other = true
      }
      if (['step_start', 'step_finish', 'reasoning', 'text'].includes(frame.type)) {
        const part = frame.part
        if (
          typeof part?.id !== 'string' ||
          !part.id ||
          (part.type !== undefined && part.type !== frame.type.replace('_', '-')) ||
          (['reasoning', 'text'].includes(frame.type) && typeof part.text !== 'string') ||
          (frame.type === 'step_finish' && part.reason !== 'stop')
        ) {
          other = true
        }
      }
      if (frame.type === 'text' && frame.part?.text) {
        answer = true
      }
      if (frame.type === 'error') {
        const data = frame.error?.data
        message ??= providerFailureMessage(data?.message ?? frame.error?.message)
        if (
          frame.error?.name === 'APIError' &&
          data?.statusCode === 429 &&
          isQuotaErrorBody(data.responseBody)
        ) {
          quota = true
        } else {
          other = true
        }
      }
    }
  } catch {
    return { ok: false as const, quota: false }
  }
  return {
    ok: false as const,
    message,
    quota: code !== null && code !== 0 && quota && !other && !answer
  }
}
