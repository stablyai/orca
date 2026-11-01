import { DESKTOP_READ_WINDOW } from '../native-chat/transcript-watch-contract'
import { ipcMain } from 'electron'
import type { AgentType } from '../../shared/agent-status-types'
import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat/native-chat-types'
import type { NativeChatSubagentActivity } from '../../shared/native-chat/input/native-chat-activity'
import type { NativeChatTaskSeedList } from '../../shared/native-chat/input/native-chat-claude-task-updates'
import { clearNativeChatTranscriptCache } from '../native-chat/transcript-read-cache'
import type { ReadTranscriptResult } from '../native-chat/transcript-reader'
import { readNativeChatTranscriptTail } from '../native-chat/transcript-watch'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { openNativeChatTranscript } from '../native-chat/native-chat-open-wake'
import {
  _getNativeChatPendingSubscriptionCountForTest,
  _getNativeChatSenderCleanupCountForTest,
  clearNativeChatSubscriptions,
  handleSubscribe,
  teardownSubscription
} from './native-chat-subscribe'

export { clearNativeChatTranscriptCache }
export {
  _getNativeChatPendingSubscriptionCountForTest,
  _getNativeChatSenderCleanupCountForTest,
  clearNativeChatSubscriptions
}

export type NativeChatReadSessionArgs = {
  agent: AgentType
  sessionId: string
  /** Recent-turn window; increase it to page backward. */
  limit?: number
  /** Hook-authoritative path when session IDs no longer identify transcript filenames. */
  transcriptPath?: string
  /** The user opened or paged this chat: may start its stopped WSL distro (E9). Absent never does. */
  wakeWslDistro?: boolean
}

// Bound parsing and rendering to the recent window; pagination raises the limit.

async function readSession(args: NativeChatReadSessionArgs): Promise<ReadTranscriptResult> {
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
    sourceOrder: true
  })
}

export type NativeChatSubscribeArgs = {
  /** Renderer ID unique within WebContents, echoed on updates to route each viewer. */
  subscriptionId: string
  agent: AgentType
  sessionId: string
  /** Authoritative transcript path from the agent hook (providerSession). */
  transcriptPath?: string
  limit?: number
  /** The user opened this chat: may start its stopped WSL distro (E9). Absent never does. */
  wakeWslDistro?: boolean
  /** Ask for the whole-file task list. Absent keeps the frame stream unchanged. */
  capabilities?: { taskList?: 1 }
}

export type NativeChatAppendedPayload = {
  subscriptionId: string
  frame:
    | {
        type: 'snapshot'
        messages: NativeChatMessage[]
        hasMore: boolean
        error?: string
        lifecycle?: NativeChatTurnLifecycle
        /** The current window has no transcript yet; do not treat it as settled history. */
        pending?: boolean
      }
    | {
        type: 'replacement'
        messages: NativeChatMessage[]
        hasMore: boolean
        lifecycle?: NativeChatTurnLifecycle
      }
    | {
        type: 'appended'
        messages: NativeChatMessage[]
        lifecycle?: NativeChatTurnLifecycle
      }
    | {
        type: 'task-list'
        taskList: NativeChatTaskSeedList | null
        subagents?: readonly NativeChatSubagentActivity[]
      }
}

export function registerNativeChatHandlers(): void {
  ipcMain.handle('nativeChat:readSession', (_event, args: NativeChatReadSessionArgs) =>
    readSession(args)
  )
  ipcMain.on('nativeChat:subscribe', (event, args: NativeChatSubscribeArgs) => {
    void handleSubscribe(event, args)
  })
  ipcMain.on('nativeChat:unsubscribe', (event, args: { subscriptionId: string }) => {
    teardownSubscription(event.sender.id, args.subscriptionId)
  })
  // Failure output is local-only because paired hosts do not transmit agent output.
  ipcMain.handle('nativeChat:conversationNameFailureOutput', (_event, sessionId: unknown) => {
    const naming = getStructuredAgentSessionHost()?.deps.conversationNaming
    return typeof sessionId === 'string' ? (naming?.failureOutput(sessionId) ?? null) : null
  })
}
