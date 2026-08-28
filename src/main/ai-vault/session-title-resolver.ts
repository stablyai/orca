import { extname } from 'node:path'
import { hasUnsafeProviderSessionIdChars } from '../../shared/agent-session-resume'
import {
  AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT,
  type AiVaultSessionTitleRequest,
  type AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import { resolveAiVaultSessionTitlesInBackground } from './session-scanner-background'
import { isWslSessionScanEnabled } from './wsl-session-home-dirs'

const TRANSCRIPT_PATH_MAX_LENGTH = 32_768

function normalizeRequest(request: AiVaultSessionTitleRequest): AiVaultSessionTitleRequest | null {
  const sessionId = request.sessionId.trim()
  if (!sessionId || sessionId.length > 512 || hasUnsafeProviderSessionIdChars(sessionId)) {
    return null
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
    const key = `${normalized.agent}\0${normalized.sessionId}`
    const previous = deduped.get(key)
    if (!previous?.transcriptPath || normalized.transcriptPath) {
      deduped.set(key, normalized)
    }
  }
  // Why: the scanner child has no store; it learns the WSL opt-out from the request.
  return resolveAiVaultSessionTitlesInBackground([...deduped.values()], signal, {
    includeWslHomes: isWslSessionScanEnabled()
  })
}
