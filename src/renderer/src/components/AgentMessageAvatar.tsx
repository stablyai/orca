import { AgentStateDot } from './AgentStateDot'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import { getAgentLabel } from '@/lib/agent-catalog'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import { formatAgentTypeLabel } from '../../../shared/agent-type-label'
import { useAgentMessageSenderView } from './native-chat/native-chat-agent-message-sender-view'
import type { AgentMessageSender } from '../../../shared/agent-session/agent-session-message-source'
import type { AgentMessageSenderView } from '../../../shared/agent-session/agent-message-presentation'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

export function AgentMessageAvatar({
  sender,
  worktreeId,
  target,
  fallback,
  pendingQuestion = false,
  tooltip = false,
  hostLabel
}: {
  sender: AgentMessageSender | undefined
  worktreeId: string | null
  target?: RuntimeClientTarget
  fallback?: AgentMessageSenderView
  pendingQuestion?: boolean
  tooltip?: boolean
  hostLabel?: string
}): React.JSX.Element {
  const view = useAgentMessageSenderView(sender, worktreeId, target)
  const dot = pendingQuestion ? 'permission' : (view.dot ?? fallback?.dot)
  const agentType = view.agentType ?? fallback?.agentType
  const label = isTuiAgent(agentType) ? getAgentLabel(agentType) : formatAgentTypeLabel(agentType)
  const description = hostLabel ? `${label} · ${hostLabel}` : label
  const avatar = (
    <div
      role={tooltip ? 'img' : undefined}
      aria-label={tooltip ? description : undefined}
      className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted"
    >
      <AgentTypeIcon agentType={agentType} size={16} className="size-4" />
      {dot ? (
        <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-card ring-2 ring-card">
          <AgentStateDot
            state={dot}
            size="md"
            progress={pendingQuestion ? undefined : view.progress}
          />
        </span>
      ) : null}
    </div>
  )
  return tooltip ? (
    <Tooltip>
      <TooltipTrigger asChild>{avatar}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {description}
      </TooltipContent>
    </Tooltip>
  ) : (
    avatar
  )
}
