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
        // Why: one stalled distro's path must not fail the whole titles batch;
        // degrade to the id-only shape like any unreadable path.
        void wslTranscriptFsRefusal(error) // rethrows anything that is not a gate refusal
        transcriptPath = null
      }
      return transcriptPath && !signal?.aborted
        ? { ...request, transcriptPath }
        : { agent: request.agent, sessionId: request.sessionId }
    })
  )
}
