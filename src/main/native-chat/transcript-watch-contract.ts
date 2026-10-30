export const DESKTOP_READ_WINDOW = 300
export const UNFLUSHED_SETTLE_MS = 1_500

import type {
  AgentType,
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat-types'
import type { ResolveSessionFileOptions } from './session-file-resolver'

export type TranscriptRecordObservation =
  | { kind: 'reset'; identity: string }
  | { kind: 'read-start'; identity: string; offset: number }
  | { kind: 'record'; identity: string; offset: number; line: string }
  | { kind: 'caught-up'; identity: string; offset: number }
  | { kind: 'gap'; identity: string }

export type SubscribeNativeChatTranscriptArgs = ResolveSessionFileOptions & {
  /** Host-only ordered records, before the display callbacks batch lifecycle edges. */
  onRecord?: (record: TranscriptRecordObservation) => void
  agent: AgentType
  sessionId: string
  onAppend: (messages: NativeChatMessage[], lifecycle?: NativeChatTurnLifecycle) => void
  onInitialSnapshot?: (
    messages: NativeChatMessage[],
    hasMore: boolean,
    beforeOffset: number,
    error?: string,
    lifecycle?: NativeChatTurnLifecycle
  ) => void
  /** Report unflushed history once before snapshots so views can leave loading without claiming a settled read. */
  onTranscriptPending?: () => void
  onReplace?: (
    messages: NativeChatMessage[],
    hasMore: boolean,
    beforeOffset: number,
    lifecycle?: NativeChatTurnLifecycle
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

export function transcriptReadRecord(
  line: string | null,
  offset: number,
  identity: string
): TranscriptRecordObservation {
  return line === null ? { kind: 'gap', identity } : { kind: 'record', identity, offset, line }
}
