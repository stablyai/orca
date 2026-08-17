import type {
  AgentType,
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat-types'
import type { ResolveSessionFileOptions } from './session-file-resolver'

export type SubscribeNativeChatTranscriptArgs = ResolveSessionFileOptions & {
  agent: AgentType
  sessionId: string
  onAppend: (messages: NativeChatMessage[], lifecycle?: NativeChatTurnLifecycle) => void
  onInitialSnapshot?: (
    messages: NativeChatMessage[],
    hasMore: boolean,
    beforeOffset: number,
    /** Set when the initial drain could not deliver a transcript. */
    error?: string,
    lifecycle?: NativeChatTurnLifecycle
  ) => void
  onReplace?: (
    messages: NativeChatMessage[],
    hasMore: boolean,
    beforeOffset: number,
    lifecycle?: NativeChatTurnLifecycle
  ) => void
  initialLimit?: number
  filePath?: string
  debounceMs?: number
  /** Test-only override for the production resolve-poll backoff. The opencode
   *  watcher also reads it as its real signal-poll interval (no fs events to
   *  debounce, so there is no separate production knob). */
  resolvePollIntervalMs?: number
  /** Test-only override for the host-side watcher reconciliation interval. */
  reconciliationIntervalMs?: number
}

/** Default number of most-recent turns the desktop read/tail paths return
 *  before pagination raises the limit — shared so the IPC default and the
 *  opencode tail cannot drift apart. */
export const DESKTOP_READ_WINDOW = 300

export type NativeChatTranscriptSubscription = {
  unsubscribe: () => void
  watching: boolean
}
