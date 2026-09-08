import type { MobileNativeChatResolution } from './mobile-native-chat-eligibility'

export type MobileNativeChatDisconnectRetention = {
  hostId: string
  worktreeId: string
  tabId: string
  resolution: MobileNativeChatResolution & { sessionId: string }
}

export function resolveMobileNativeChatDuringDisconnect(args: {
  connected: boolean
  hostId: string
  worktreeId: string
  tabId: string | null
  terminalTabPresent: boolean
  chatViewSelected: boolean
  currentResolution: MobileNativeChatResolution | null
  retained: MobileNativeChatDisconnectRetention | null
}): {
  resolution: MobileNativeChatResolution | null
  retained: MobileNativeChatDisconnectRetention | null
} {
  if (!args.chatViewSelected || !args.tabId || !args.terminalTabPresent) {
    return { resolution: args.currentResolution, retained: null }
  }

  if (args.currentResolution?.sessionId) {
    const retained = {
      hostId: args.hostId,
      worktreeId: args.worktreeId,
      tabId: args.tabId,
      resolution: {
        ...args.currentResolution,
        sessionId: args.currentResolution.sessionId
      }
    }
    return { resolution: args.currentResolution, retained }
  }

  if (args.connected) {
    return { resolution: args.currentResolution, retained: null }
  }

  if (
    args.retained?.hostId === args.hostId &&
    args.retained.worktreeId === args.worktreeId &&
    args.retained.tabId === args.tabId &&
    (!args.currentResolution || args.currentResolution.agent === args.retained.resolution.agent)
  ) {
    return { resolution: args.retained.resolution, retained: args.retained }
  }

  return { resolution: args.currentResolution, retained: null }
}
