export type DesktopNotificationDispatchEvent = {
  type: 'notification'
  legacySocketAllowed?: boolean
  desktopAllowed?: boolean
  desktopAway?: boolean
  source?: 'agent-task-complete' | 'terminal-bell' | 'test' | 'plugin'
  agentState?: string
  title?: string
  body?: string
  agentPrompt?: string
  agentLastAssistantMessage?: string
  worktreeId?: string
  executionHost?: string
  paneKey?: string
  notificationId?: string
  notificationSeq?: number
  notificationEpoch?: string
  structuredOrigin?: {
    sessionId?: string
  }
}

export type DismissNotificationEvent = {
  type: 'dismiss'
  notificationId: string
  notificationSeq?: number
  notificationEpoch?: string
  dismissedDelivery?: {
    notificationId: string
    notificationEpoch: string
    notificationSeq: number
  }
}
