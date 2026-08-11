import type { AiVaultSessionTitleRequest } from '../../shared/ai-vault-session-title'
import { toHostReadableTranscriptPath } from '../native-chat/host-readable-transcript-path'

export function resolveHostReadableAiVaultTitleRequests(
  requests: AiVaultSessionTitleRequest[],
  signal?: AbortSignal
): Promise<AiVaultSessionTitleRequest[]> {
  return Promise.all(
    requests.map(async (request): Promise<AiVaultSessionTitleRequest> => {
      if (!request.transcriptPath || signal?.aborted) {
        return request
      }
      const transcriptPath = await toHostReadableTranscriptPath(request.transcriptPath)
      return transcriptPath && !signal?.aborted
        ? { ...request, transcriptPath }
        : { agent: request.agent, sessionId: request.sessionId }
    })
  )
}
