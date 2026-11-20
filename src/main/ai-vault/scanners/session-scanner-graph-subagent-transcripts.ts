import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import { countOmpSubagentTranscripts } from './omp/session-scanner-omp-subagent-transcripts'
import { countPiSubagentTranscripts } from './pi/session-scanner-pi-subagent-transcripts'
import type { ResumableSessionParseState } from '../session-scanner-types'

/** The transcript-owning host alone counts children; a parsed OMP file keeps OMP's reader. */
async function countGraphSubagentTranscripts(
  agent: string,
  transcriptFilePath: string,
  signal?: AbortSignal
): Promise<number | null> {
  if (agent === 'omp') {
    return countOmpSubagentTranscripts(transcriptFilePath, signal)
  }
  return agent === 'pi' ? countPiSubagentTranscripts(transcriptFilePath, signal) : null
}

/** Attach the child count a graph-parsed session's own stem directory holds. */
export function withGraphSubagentTranscriptCount(
  state: ResumableSessionParseState,
  transcriptFilePath: string
): ResumableSessionParseState {
  return {
    consumeLine: (line) => state.consumeLine(line),
    identity: () => state.identity?.() ?? null,
    clone: () => withGraphSubagentTranscriptCount(state.clone(), transcriptFilePath),
    touchFile: (file) => state.touchFile(file),
    finalize: async (platform, options) => {
      const session = await state.finalize(platform, options)
      const ownsTranscriptDisk =
        !options?.executionHostId || options.executionHostId === LOCAL_EXECUTION_HOST_ID
      if (!session || !ownsTranscriptDisk) {
        return session
      }
      const subagentTranscriptCount = await countGraphSubagentTranscripts(
        session.agent,
        transcriptFilePath,
        options?.signal
      )
      return subagentTranscriptCount === null ? session : { ...session, subagentTranscriptCount }
    }
  }
}
