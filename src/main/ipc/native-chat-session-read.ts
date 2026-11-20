import type { AgentType } from '../../shared/agent-status/contracts/agent-status-types'
import { DESKTOP_READ_WINDOW } from '../native-chat/transcript-watching/transcript-watch-contract'
import { readNativeChatTranscriptTail } from '../native-chat/transcript-tail-reader'
import { openNativeChatTranscript } from '../native-chat/transcript-discovery/native-chat-open-wake'

export type NativeChatReadSessionArgs = {
  agent: AgentType
  sessionId: string
  /** Recent-turn window; increase it to page backward. */
  limit?: number
  /** Hook-authoritative path when session IDs no longer identify transcript filenames. */
  transcriptPath?: string
  /** The user opened or paged this chat: may start its stopped WSL distro (E9). Absent never does. */
  wakeWslDistro?: boolean
  /** Provider row cursor for an older page; absent reads the newest window. */
  beforeOffset?: number
}

const isTranscriptCursor = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export async function readSession(args: NativeChatReadSessionArgs) {
  const { agent, sessionId } = args
  const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : DESKTOP_READ_WINDOW
  const wake = args.wakeWslDistro === true
  const { transcriptPath, waking } = openNativeChatTranscript(sessionId, args.transcriptPath, wake)
  await waking
  return readNativeChatTranscriptTail({
    agent,
    sessionId,
    transcriptPath,
    limit,
    beforeOffset: isTranscriptCursor(args.beforeOffset) ? args.beforeOffset : undefined,
    sourceOrder: true
  })
}
