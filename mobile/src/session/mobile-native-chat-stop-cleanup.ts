import type { RpcClient } from '../transport/rpc-client'
import {
  openMobileNativeChatSendBudget,
  sendMobileNativeChatMessageWithOutcome,
  type MobileNativeChatSendOutcome
} from './mobile-native-chat-send'
import { requestMobileNativeChatStopLease } from './mobile-native-chat-stop-lease'

const CODEX_STOP_BACKGROUND_TERMINALS = '/stop'

type PendingStopCleanup = {
  readonly sessionId: string
  readonly terminal: string
}

const pendingByStream = new Map<string, PendingStopCleanup>()

export function rememberMobileNativeChatStopCleanup(args: {
  streamIdentity: string
  sessionId: string | null
  terminal: string
}): boolean {
  if (!args.sessionId) {
    return false
  }
  pendingByStream.set(args.streamIdentity, {
    sessionId: args.sessionId,
    terminal: args.terminal
  })
  return true
}

export function hasMobileNativeChatStopCleanup(streamIdentity: string): boolean {
  return pendingByStream.has(streamIdentity)
}

export async function recoverMobileNativeChatStopCleanup(args: {
  client: RpcClient
  deviceToken: string | null
  sessionId: string | null
  shouldSend: () => boolean
  streamIdentity: string
  terminal: string
}): Promise<MobileNativeChatSendOutcome | 'busy' | 'none'> {
  const pending = pendingByStream.get(args.streamIdentity)
  if (!pending || pending.sessionId !== args.sessionId || pending.terminal !== args.terminal) {
    return 'none'
  }
  const request = requestMobileNativeChatStopLease(args.terminal)
  if (!request) {
    return 'busy'
  }
  const lease = await request.acquired
  if (!lease) {
    return 'busy'
  }
  try {
    const current = pendingByStream.get(args.streamIdentity)
    if (current !== pending || !args.shouldSend()) {
      return 'none'
    }
    const outcome = await sendMobileNativeChatMessageWithOutcome({
      client: args.client,
      terminal: args.terminal,
      text: CODEX_STOP_BACKGROUND_TERMINALS,
      enter: true,
      deadline: openMobileNativeChatSendBudget(),
      ...(args.deviceToken
        ? { mobileClient: { id: args.deviceToken, type: 'mobile' as const } }
        : {})
    })
    if (outcome !== 'rejected' && pendingByStream.get(args.streamIdentity) === pending) {
      pendingByStream.delete(args.streamIdentity)
    }
    return outcome
  } finally {
    lease.release()
  }
}

export function resetMobileNativeChatStopCleanupForTests(): void {
  pendingByStream.clear()
}
