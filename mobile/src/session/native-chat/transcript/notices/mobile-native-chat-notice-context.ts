import { createContext } from 'react'
import type { MobileStructuredInterruptedContinue } from '../../composer/delivery/use-mobile-structured-interrupted-continue'
import type { MobileNativeChatUsageLimit } from '../../status/use-mobile-native-chat-usage-limit'

/** What a notice row needs: the Orca host behind the chat (null when unnamed), the agent, and Continue for an Orca-stopped turn. */
export type MobileNativeChatNoticeView = {
  hostName: string | null
  agentName?: string
  continuation?: Pick<
    MobileStructuredInterruptedContinue,
    'continueAvailable' | 'offeredTurnItemId' | 'continueNow'
  >
  /** Opens a host terminal tab in the chat's workspace running `command`. */
  onRunInTerminal?: (command: string) => void
  /** The usage-limit row the person can act on; null when none can be. */
  usageLimit?: MobileNativeChatUsageLimit | null
  /** Opens the accounts of the host that runs this chat; absent when the phone can't reach them. */
  openAccounts?: () => void
  /** Rows whose failure no later successful turn resolved; absent when the transcript is unknown. */
  unresolvedFailureRows?: ReadonlySet<string>
}

export function mobileNativeChatNoticeView(args: {
  hostName: string | null
  agentName?: string
  onRunInTerminal: (command: string) => void
  usageLimit: MobileNativeChatUsageLimit | null | undefined
  unresolvedFailureRows: ReadonlySet<string> | undefined
  onOpenAccounts?: () => void
  continuation: MobileStructuredInterruptedContinue | null
  onClearSendError: () => void
}): MobileNativeChatNoticeView {
  const { continuation } = args
  return {
    hostName: args.hostName,
    ...(args.agentName ? { agentName: args.agentName } : {}),
    onRunInTerminal: args.onRunInTerminal,
    usageLimit: args.usageLimit,
    unresolvedFailureRows: args.unresolvedFailureRows,
    ...(args.onOpenAccounts ? { openAccounts: args.onOpenAccounts } : {}),
    ...(continuation
      ? {
          continuation: {
            ...continuation,
            // A Continue tap is the person's newer action, so it clears the composer's error.
            continueNow: () => {
              args.onClearSendError()
              continuation.continueNow()
            }
          }
        }
      : {})
  }
}

export const MobileNativeChatNoticeContext = createContext<MobileNativeChatNoticeView>({
  hostName: null
})

/** Opens the chat a "Forked from" divider names; absent where the view cannot open chats. */
export const MobileNativeChatForkedFromContext = createContext<
  ((sourceSessionId: string) => void) | undefined
>(undefined)
