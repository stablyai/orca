import type { AiVaultSessionTitleRequest } from '../../shared/ai-vault-session-title'
import {
  needsWslHostTranslation,
  toHostReadableTranscriptPath
} from '../native-chat/host-readable-transcript-path'
import { wslTranscriptFsRefusal } from '../native-chat/wsl-transcript-fs-gate'

export function resolveHostReadableAiVaultTitleRequests(
  requests: AiVaultSessionTitleRequest[],
  includeWslHomes = true,
  signal?: AbortSignal
): Promise<AiVaultSessionTitleRequest[]> {
  return Promise.all(
    requests.map(async (request): Promise<AiVaultSessionTitleRequest> => {
      if (!request.transcriptPath || signal?.aborted) {
        return request
      }
      // Why: with WSL scanning off, a guest path has no UNC twin to probe and
      // translating it would boot the distro — degrade to id-only up front.
      if (!includeWslHomes && needsWslHostTranslation(request.transcriptPath)) {
        return { agent: request.agent, sessionId: request.sessionId }
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
