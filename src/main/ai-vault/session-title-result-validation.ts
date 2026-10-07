import {
  AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT,
  type AiVaultSessionTitle,
  type AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'

export function parseAiVaultSessionTitlesResult(value: unknown): AiVaultSessionTitlesResult {
  if (!value || typeof value !== 'object') {
    throw new Error('expected an object')
  }
  const titles = (value as { titles?: unknown }).titles
  if (!Array.isArray(titles) || titles.length > AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT) {
    throw new Error('expected a bounded titles array')
  }
  return { titles: titles.map(parseTitle) }
}

function parseTitle(value: unknown): AiVaultSessionTitle {
  if (!value || typeof value !== 'object') {
    throw new Error('expected a title object')
  }
  const record = value as Record<string, unknown>
  if (
    (record.agent !== 'claude' && record.agent !== 'codex') ||
    typeof record.sessionId !== 'string' ||
    !record.sessionId.trim() ||
    record.sessionId.length > 512 ||
    typeof record.title !== 'string' ||
    !record.title.trim() ||
    record.title.length > 512
  ) {
    throw new Error('invalid session title')
  }
  return {
    agent: record.agent,
    sessionId: record.sessionId,
    title: record.title.trim()
  }
}
