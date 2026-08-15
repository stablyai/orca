import React from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import { cn } from '@/lib/utils'

// Why: "the agent is asking you something" shows up in the sidebar, terminal
// tabs, the dashboard, the kanban and the agent map. One icon + one token
// (--agent-question) so the four never drift apart; the map paints the same
// token from agent-map.css. Callers pass sizing via className.

type AgentQuestionIconProps = React.ComponentProps<typeof MessageCircleQuestion>

export function AgentQuestionIcon({
  className,
  ...props
}: AgentQuestionIconProps): React.JSX.Element {
  return (
    <MessageCircleQuestion
      {...props}
      className={cn('text-agent-question', className)}
      aria-hidden="true"
    />
  )
}
