import type React from 'react'
import { MessageSquareQuote } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { WORKTREE_CONTEXT_MENU_SCOPE_ATTR } from '@/components/sidebar/worktree-context-menu-policy'
import { referenceConversationInFocusedChat } from '@/components/native-chat/conversation-reference-insertion'
import {
  agentRowConversationReference,
  canReferenceAgentRow
} from '@/lib/agent-row-conversation-reference'
import { translate } from '@/i18n/i18n'

const stopPropagation = (event: React.SyntheticEvent): void => event.stopPropagation()

/**
 * An agent row's own right-click menu. It claims the nested menu scope only when it has something
 * to offer, so a row without a conversation still opens its workspace's menu.
 */
export function AgentRowContextMenu({
  agent,
  title,
  disabled = false,
  children
}: {
  agent: DashboardAgentRow
  title: string
  /** Send-target mode makes the row a picker, with no menu of its own. */
  disabled?: boolean
  children: React.ReactElement
}): React.JSX.Element {
  if (disabled || !canReferenceAgentRow(agent)) {
    return children
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild {...{ [WORKTREE_CONTEXT_MENU_SCOPE_ATTR]: 'agent-row' }}>
        {children}
      </ContextMenuTrigger>
      {/* Why: portaled items still bubble through React to the card, which would activate it. */}
      <ContextMenuContent
        onClick={stopPropagation}
        onPointerDown={stopPropagation}
        onMouseDown={stopPropagation}
        onKeyDown={stopPropagation}
      >
        <ContextMenuItem
          onSelect={() =>
            void referenceConversationInFocusedChat(agentRowConversationReference(agent, title))
          }
        >
          <MessageSquareQuote className="size-3.5" />
          {translate(
            'components.native-chat.conversationReference.reference',
            'Reference conversation'
          )}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
