import { createHash } from 'node:crypto'
import { normalizeTitleText } from './session-scanner-values'

export function antigravityHistoryPromptHash(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) {
    return null
  }
  const prompt = normalizeTitleText(value)
  return prompt && !prompt.endsWith('...')
    ? createHash('sha256').update(prompt).digest('hex')
    : null
}
