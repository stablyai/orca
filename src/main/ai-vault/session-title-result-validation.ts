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
  const owner: unknown = record.structuredSession
  if (
    owner !== undefined &&
    (typeof owner !== 'object' ||
      owner === null ||
      !('workspaceId' in owner) ||
      typeof owner.workspaceId !== 'string' ||
      !owner.workspaceId.trim() ||
      owner.workspaceId.length > 4096 ||
      !('sessionId' in owner) ||
      typeof owner.sessionId !== 'string' ||
      !owner.sessionId.trim() ||
      owner.sessionId.length > 512)
  ) {
    throw new Error('invalid structured session title owner')
  }
  return {
    agent: record.agent,
    sessionId: record.sessionId,
    title: record.title.trim(),
    ...(owner &&
    typeof owner === 'object' &&
    'workspaceId' in owner &&
    typeof owner.workspaceId === 'string' &&
    'sessionId' in owner &&
    typeof owner.sessionId === 'string'
      ? { structuredSession: { workspaceId: owner.workspaceId, sessionId: owner.sessionId } }
      : {})
  }
}
