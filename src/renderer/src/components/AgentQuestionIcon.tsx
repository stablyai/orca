import React from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import { cn } from '@/lib/utils'

// Share the question glyph and --agent-question token across sidebar, tabs, dashboard and kanban; callers choose size.

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
