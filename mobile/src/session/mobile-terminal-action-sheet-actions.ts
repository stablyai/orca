import { Eraser, Monitor, Smartphone } from 'lucide-react-native'
import type { TerminalTabViewMode } from '../../../src/shared/terminal-tab-view-mode'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import type { MobileNativeChatTab } from './mobile-native-chat-eligibility'
import { getMobileNativeChatToggleActions } from './mobile-native-chat-toggle-action'
import type { MobileLeafView } from './mobile-session-chat-view'

type TerminalTab = MobileNativeChatTab & { id: string; terminal: string | null }

/** Builds the terminal long-press menu without adding another action block to the
 *  already dense session route. Native chat stays first as the view switch. */
export function getMobileTerminalActionSheetActions<
  Target extends { tabId: string; handle: string | null },
  Tab extends TerminalTab
>(args: {
  target: Target | null
  tabs: readonly Tab[]
  tabLeafView: (tab: Tab) => MobileLeafView
  nativeChatTranscriptIsLocalReadable: boolean
  onDismiss: () => void
  onSetChatView: (tabId: string, view: TerminalTabViewMode) => void
  isPhoneMode: (handle: string) => boolean
  onToggleDisplayMode: (handle: string) => void
  onRename: (target: Target & { handle: string }) => void
  onClear: (target: Target & { handle: string }) => void
  /** Fallback for a live handle with no matching session tab. */
  onClose: (target: Target & { handle: string }) => void
  /** Preferred path runs host teardown and records the local tombstone. */
  onCloseSessionTab: (tab: Tab) => void
  /** Appended after Close; receives the pressed tab's id so the session route's
   *  bulk-close builder can resolve the anchor itself. */
  bulkCloseActions?: (anchorTabId: string | undefined, dismiss: () => void) => ActionSheetAction[]
}): ActionSheetAction[] {
  const { target } = args
  if (!target) {
    return []
  }
  const sessionTab = args.tabs.find((tab) => tab.id === target.tabId)
  const { handle } = target
  // Why by tab id: a chat row still waiting for its terminal handle must reach the view switch and Close.
  const handleTarget = typeof handle === 'string' ? { ...target, handle } : null
  const phoneMode = handle !== null && args.isPhoneMode(handle)
  return [
    ...getMobileNativeChatToggleActions({
      tab: sessionTab ?? null,
      leafView: sessionTab ? args.tabLeafView(sessionTab) : 'terminal',
      nativeChatTranscriptIsLocalReadable: args.nativeChatTranscriptIsLocalReadable,
      onClose: args.onDismiss,
      onSetView: args.onSetChatView
    }),
    ...(handleTarget
      ? [
          {
            label: phoneMode ? 'Switch to Desktop' : 'Switch to Phone',
            icon: phoneMode ? Monitor : Smartphone,
            onPress: () => {
              args.onDismiss()
              args.onToggleDisplayMode(handleTarget.handle)
            }
          },
          {
            label: 'Rename',
            closeBeforePress: true,
            onPress: () => {
              args.onRename(handleTarget)
            }
          },
          {
            label: 'Clear Terminal',
            icon: Eraser,
            onPress: () => {
              args.onDismiss()
              args.onClear(handleTarget)
            }
          }
        ]
      : []),
    ...(sessionTab || handleTarget
      ? [
          {
            label: 'Close',
            destructive: true,
            onPress: () => {
              args.onDismiss()
              if (sessionTab) {
                args.onCloseSessionTab(sessionTab)
                return
              }
              if (handleTarget) {
                args.onClose(handleTarget)
              }
            }
          }
        ]
      : []),
    ...(args.bulkCloseActions?.(sessionTab?.id, args.onDismiss) ?? [])
  ]
}
