import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { listStructuredProviderSessionOwnership } from '../native-chat/agent-session-wire/structured-provider-session-ownership'
import { extname } from 'node:path'
import { hasUnsafeProviderSessionIdChars } from '../../shared/agent-session-resume'
import {
  AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT,
  type AiVaultSessionTitle,
  type AiVaultSessionTitleRequest,
  type AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import { resolveAiVaultSessionTitlesInBackground } from './session-scanner-background'

const TRANSCRIPT_PATH_MAX_LENGTH = 32_768

function normalizeRequest(request: AiVaultSessionTitleRequest): AiVaultSessionTitleRequest | null {
  const sessionId = request.sessionId.trim()
  if (!sessionId || sessionId.length > 512 || hasUnsafeProviderSessionIdChars(sessionId)) {
    return null
  }
  if (request.structuredSession !== undefined) {
    const owner = request.structuredSession
    if (
      !owner ||
      typeof owner.workspaceId !== 'string' ||
      !owner.workspaceId.trim() ||
      owner.workspaceId.length > 4096 ||
      typeof owner.sessionId !== 'string' ||
      !owner.sessionId.trim() ||
      owner.sessionId.length > 512 ||
      hasUnsafeProviderSessionIdChars(owner.sessionId)
    ) {
      return null
    }
    return { agent: request.agent, sessionId, structuredSession: owner }
  }
  const transcriptPath = request.transcriptPath?.trim()
  if (
    !transcriptPath ||
    transcriptPath.length > TRANSCRIPT_PATH_MAX_LENGTH ||
    hasUnsafeProviderSessionIdChars(transcriptPath) ||
    extname(transcriptPath).toLowerCase() !== '.jsonl'
  ) {
    return { agent: request.agent, sessionId }
  }
  return { agent: request.agent, sessionId, transcriptPath }
}

export async function resolveLocalAiVaultSessionTitles(
  requests: AiVaultSessionTitleRequest[],
  signal?: AbortSignal
): Promise<AiVaultSessionTitlesResult> {
  const deduped = new Map<string, AiVaultSessionTitleRequest>()
  for (const request of requests.slice(0, AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT)) {
    const normalized = normalizeRequest(request)
    if (!normalized) {
      continue
    }
    const key = JSON.stringify([
      normalized.agent,
      normalized.sessionId,
      normalized.structuredSession
    ])
    const previous = deduped.get(key)
    if (!previous?.transcriptPath || normalized.transcriptPath) {
      deduped.set(key, normalized)
    }
  }
  if (signal?.aborted) {
    return { titles: [] }
  }
  const titles: AiVaultSessionTitle[] = []
  const legacy: AiVaultSessionTitleRequest[] = []
  for (const request of deduped.values()) {
    const owner = request.structuredSession
    if (!owner) {
      legacy.push(request)
      continue
    }
    const record = getStructuredAgentSessionHost()?.deps.store.getRecord(owner.sessionId)
    if (
      !record ||
      record.location.executionHostId !== 'local' ||
      record.location.wslDistro !== null ||
      record.location.workspaceId !== owner.workspaceId ||
      record.provider !== request.agent ||
      !record.conversationName ||
      !listStructuredProviderSessionOwnership([record]).some(
        (ownership) => ownership.providerSessionId === request.sessionId
      )
    ) {
      continue
    }
    titles.push({
      agent: request.agent,
      sessionId: request.sessionId,
      title: record.conversationName,
      structuredSession: owner
    })
  }
  if (legacy.length) {
    titles.push(...(await resolveAiVaultSessionTitlesInBackground(legacy, signal)).titles)
  }
  return signal?.aborted ? { titles: [] } : { titles }
}
