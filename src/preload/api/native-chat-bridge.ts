import { ipcRenderer } from 'electron'
import type {
  NativeChatAppendedPayload,
  NativeChatReadSessionResult,
  NativeChatSubscriptionFrame,
  PreloadApi
} from '../api-types'
import type { AgentType } from '../../shared/agent-status-types'

export const nativeChatApi = {
  readSession: (
    agent: AgentType,
    sessionId: string,
    limit?: number,
    transcriptPath?: string,
    options?: { wakeWslDistro?: boolean; beforeOffset?: number; subagentId?: string }
  ): Promise<NativeChatReadSessionResult> =>
    ipcRenderer.invoke('nativeChat:readSession', {
      agent,
      sessionId,
      limit,
      transcriptPath,
      wakeWslDistro: options?.wakeWslDistro,
      beforeOffset: options?.beforeOffset,
      subagentId: options?.subagentId
    }),
  subscribe: (
    args: {
      subscriptionId: string
      agent: AgentType
      sessionId: string
      transcriptPath?: string
      limit?: number
      wakeWslDistro?: boolean
      capabilities?: { taskList?: 1 }
    },
    onFrame: (frame: NativeChatSubscriptionFrame) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: NativeChatAppendedPayload) => {
      if (payload.subscriptionId === args.subscriptionId) {
        onFrame(payload.frame)
      }
    }
    ipcRenderer.on('nativeChat:appended', listener)
    ipcRenderer.send('nativeChat:subscribe', args)
    return () => {
      ipcRenderer.removeListener('nativeChat:appended', listener)
      ipcRenderer.send('nativeChat:unsubscribe', { subscriptionId: args.subscriptionId })
    }
  },
  getConversationNameFailureOutput: (sessionId: string): Promise<string | null> =>
    ipcRenderer.invoke('nativeChat:conversationNameFailureOutput', sessionId)
} satisfies PreloadApi['nativeChat']
