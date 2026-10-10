import React from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import { cn } from '@/lib/utils'

// Why: "the agent is asking you something" shows up in the sidebar, terminal
// tabs, the dashboard and the kanban. One icon + one token (--agent-question)
// so they never drift apart. Callers pass sizing via className.

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
