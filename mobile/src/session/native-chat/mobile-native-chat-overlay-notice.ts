import { tuiAgentDisplayName } from '../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import type { MobileStructuredInterruptedContinue } from './composer/delivery/use-mobile-structured-interrupted-continue'
import type { MobileNativeChatUsageLimit } from './status/use-mobile-native-chat-usage-limit'
import type { MobileNativeChatNoticeView } from './transcript/notices/mobile-native-chat-notice-context'

/** Notice-row inputs. Continue clears the composer error because it is the newer action. */
export function mobileNativeChatOverlayNotice({
  hostName,
  agent,
  runInTerminal,
  usageLimit,
  unresolvedFailureRows,
  onOpenAccounts,
  continuation,
  onClearSendError
}: {
  hostName: string | null
  agent: string
  runInTerminal: (command: string) => void
  usageLimit: MobileNativeChatUsageLimit | null
  unresolvedFailureRows: ReadonlySet<string> | undefined
  onOpenAccounts?: () => void
  continuation: MobileStructuredInterruptedContinue | null
  onClearSendError: () => void
}): MobileNativeChatNoticeView {
  return {
    hostName,
    ...(agent ? { agentName: tuiAgentDisplayName(agent) ?? agent } : {}),
    onRunInTerminal: runInTerminal,
    usageLimit,
    unresolvedFailureRows,
    ...(onOpenAccounts ? { openAccounts: onOpenAccounts } : {}),
    ...(continuation
      ? {
          continuation: {
            continueAvailable: continuation.continueAvailable,
            offeredTurnItemId: continuation.offeredTurnItemId,
            continueNow: () => {
              onClearSendError()
              continuation.continueNow()
            }
          }
        }
      : {})
  }
}
