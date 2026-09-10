import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../../src/shared/native-chat-types'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { MobileNativeChatStreamFrame } from './mobile-native-chat-stream-frame'

export type HostSessionNativeChatTarget = {
  workspaceId: string
  agent: string
  sessionId: string
  transcriptPath: string | null
  terminalId: string | null
  clientId: string | null
}

export type HostSessionNativeChatReadResult =
  | {
      messages: NativeChatMessage[]
      hasMore?: boolean
      beforeOffset?: number
      lifecycle?: NativeChatTurnLifecycle
    }
  | { error: string }

export type HostSessionNativeChatImageAttachment = {
  reference: string
  previewUri: string
}

export type HostSessionNativeChatOperations = {
  /** Whether the serving host can read this workspace's agent transcripts. */
  readability(workspaceId: string): Promise<boolean>
  /** No error callback: the transport has none, and a stream error arrives as an `error` frame
   *  through `onEvent`, which is where the caller already handles it. */
  subscribe(
    target: HostSessionNativeChatTarget,
    limit: number,
    onEvent: (event: MobileNativeChatStreamFrame) => void
  ): () => void
  read(
    target: HostSessionNativeChatTarget,
    limit: number,
    beforeOffset?: number
  ): Promise<HostSessionNativeChatReadResult>
  stop(target: HostSessionNativeChatTarget, deadline?: number): Promise<MobileNativeChatSendOutcome>
  /** Drops the legacy full-inventory fallback's cached listing for a workspace. Without it a
   *  second visit inside one connection serves the first read's inventory, so a file created in
   *  between is missing from `@` autocomplete. */
  resetFileSearchCache(workspaceId: string): void
  /** Null when the host refused the search. An empty array is a real answer the caller may
   *  cache; a refusal must not be cached, or the next keystroke would never retry. */
  searchFiles(target: HostSessionNativeChatTarget, query: string): Promise<string[] | null>
}
