import type { AiVaultSessionTitleRequest } from '../../shared/ai-vault-session-title'
import { toHostReadableTranscriptPath } from '../native-chat/host-readable-transcript-path'
import { wslTranscriptFsRefusal } from '../native-chat/wsl-transcript-fs-gate'

export function resolveHostReadableAiVaultTitleRequests(
  requests: AiVaultSessionTitleRequest[],
  signal?: AbortSignal
): Promise<AiVaultSessionTitleRequest[]> {
  return Promise.all(
    requests.map(async (request): Promise<AiVaultSessionTitleRequest> => {
      if (!request.transcriptPath || signal?.aborted) {
        return request
      }
      let transcriptPath: string | null
      try {
        transcriptPath = await toHostReadableTranscriptPath(request.transcriptPath)
      } catch (error) {
        // A stalled distro falls back to an id-only request without failing other titles.
        void wslTranscriptFsRefusal(error)
        transcriptPath = null
      }
      return transcriptPath && !signal?.aborted
        ? { ...request, transcriptPath }
        : { agent: request.agent, sessionId: request.sessionId }
    })
  )
}
