import type { TranscriptByteRange } from '../../../shared/native-chat/transcript/transcript-byte-range'

export const DESKTOP_READ_WINDOW = 300
export const UNFLUSHED_SETTLE_MS = 1_500

import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../../shared/native-chat/native-chat-types'
import type { ResolveSessionFileOptions } from '../session-file-resolver'

export type SubscribeNativeChatTranscriptArgs = ResolveSessionFileOptions & {
  agent: AgentType
  sessionId: string
  onAppend: (
    messages: NativeChatMessage[],
    lifecycle?: NativeChatTurnLifecycle,
    ranges?: TranscriptByteRange[]
  ) => void
  onInitialSnapshot?: (
    messages: NativeChatMessage[],
    hasMore: boolean,
    beforeOffset: number,
    error?: string,
    lifecycle?: NativeChatTurnLifecycle,
    ranges?: TranscriptByteRange[]
  ) => void
  /** Report unflushed history once before snapshots so views can leave loading without claiming a settled read. */
  onTranscriptPending?: () => void
  onReplace?: (
    messages: NativeChatMessage[],
    hasMore: boolean,
    beforeOffset: number,
    lifecycle?: NativeChatTurnLifecycle,
    ranges?: TranscriptByteRange[]
  ) => void
  initialLimit?: number
  sourceOrder?: boolean
  filePath?: string
  debounceMs?: number
  resolvePollIntervalMs?: number
  reconciliationIntervalMs?: number
}

export type NativeChatTranscriptSubscription = {
  unsubscribe: () => void
  watching: boolean
}
