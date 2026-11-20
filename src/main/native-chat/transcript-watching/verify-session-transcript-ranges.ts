import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import type { TranscriptByteRange } from '../../../shared/native-chat/transcript/transcript-byte-range'
import { resolveSessionFilePath } from '../session-file-resolver'
import { verifyTranscriptRanges } from './transcript-range-verifier'

export async function verifySessionTranscriptRanges(
  args: {
    agent: AgentType
    sessionId: string
    transcriptPath?: string
    ranges: TranscriptByteRange[]
  },
  signal?: AbortSignal
): Promise<boolean[]> {
  try {
    const path = await resolveSessionFilePath(args.agent, args.sessionId, args, signal)
    return path
      ? await verifyTranscriptRanges(path, args.ranges, signal)
      : args.ranges.map(() => false)
  } catch {
    signal?.throwIfAborted()
    return args.ranges.map(() => false)
  }
}
