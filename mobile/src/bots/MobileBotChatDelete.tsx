// Delete chat on a Chats row, as the desktop's row menu (BotChatRowMenu): a long-press opens Open and
// Delete chat, a confirm beside the drawer asks, then the chat's host deletes it and closes its tabs.
import { useRef, useState, type ReactNode } from 'react'
import { View, type HostInstance } from 'react-native'
import { ArrowUpRight, Trash2 } from 'lucide-react-native'
import {
  AGENT_SESSION_PHONE_DELETE_RUNTIME_CAPABILITY,
  orcaChatDeleteRefusalText,
  type OrcaChatDeleteResult
} from '../../../src/shared/agent-session/chat-deletion/orca-chat-delete'
import { botChatOffersDelete, type BotChatTreeChat } from '../../../src/shared/bots/bot-chat-tree'
import type { PresentAutomationSheet } from '../automations/AutomationSheets'
import { PullDownMenu } from '../components/nav-bar/PullDownMenu'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { triggerMediumImpact } from '../platform/haptics/haptics'
import { callAgentSession } from '../session/native-chat/agent-session/mobile-structured-agent-session-rpc'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { useRouteCapability } from '../worktree/execution-hosts/use-route-capability'

// The desktop's wait: the host stops a running chat before it deletes it.
const DELETE_TIMEOUT_MS = 120_000

/** Asks, then deletes the chat on its host; null where the host can't take a phone's delete. */
export function useMobileBotChatDelete(
  panel: {
    client: RpcClient | null
    hostName: string
    online: boolean
    /** Re-reads the bot's chats once one is gone. */
    routeBot: { refresh: () => void }
  },
  present: PresentAutomationSheet,
  showToast: (message: string) => void
): ((chat: BotChatTreeChat) => void) | null {
  const t = useMobileTranslation()
  const offered = useRouteCapability(AGENT_SESSION_PHONE_DELETE_RUNTIME_CAPABILITY)
  const { client } = panel
  if (!client || !panel.online || !offered) {
    return null
  }
  const remove = async (chat: BotChatTreeChat) => {
    try {
      const result = await callAgentSession<OrcaChatDeleteResult>(
        client,
        'agentSession.delete',
        { sessionId: chat.chatId },
        DELETE_TIMEOUT_MS,
        // A confirm the connection dropped under says so now, never deletes on a later reconnect.
        { failWhenDisconnected: true }
      )
      // Not found: another delete got there first, so the chat is gone all the same.
      if (result.outcome === 'deleted' || result.reason === 'not-found') {
        panel.routeBot.refresh()
        return
      }
      showToast(orcaChatDeleteRefusalText(t, result.reason))
    } catch {
      showToast(t('chats.delete.failed', "Couldn't delete the chat"))
    }
  }
  return (chat) =>
    present({
      kind: 'confirm',
      title: t('chats.delete.title', 'Delete this chat?'),
      message: t(
        'chats.delete.descriptionHost',
        "It's deleted permanently from {{host}}. This can't be undone.",
        { host: panel.hostName }
      ),
      confirmLabel: t('chats.delete.action', 'Delete'),
      destructive: true,
      onConfirm: () => void remove(chat)
    })
}

/** A chat row with the desktop's row menu on long-press, where the chat can be deleted. */
export function MobileBotChatMenu({
  chat,
  onOpen,
  onDelete,
  children
}: {
  chat: BotChatTreeChat
  onOpen: () => void
  onDelete: ((chat: BotChatTreeChat) => void) | undefined
  children: (onLongPress: (() => void) | undefined) => ReactNode
}) {
  const t = useMobileTranslation()
  const anchor = useRef<HostInstance>(null)
  const [open, setOpen] = useState(false)
  if (!onDelete || !botChatOffersDelete(chat)) {
    return children(undefined)
  }
  return (
    <View ref={anchor} collapsable={false}>
      {children(() => {
        triggerMediumImpact()
        setOpen(true)
      })}
      <PullDownMenu
        visible={open}
        anchorRef={anchor}
        groups={[
          [
            {
              label: t('bots.chats.open', 'Open'),
              icon: ArrowUpRight,
              closeBeforePress: true,
              onPress: onOpen
            }
          ],
          [
            {
              label: t('bots.chats.delete', 'Delete chat'),
              icon: Trash2,
              destructive: true,
              closeBeforePress: true,
              onPress: () => onDelete(chat)
            }
          ]
        ]}
        onClose={() => setOpen(false)}
      />
    </View>
  )
}
