import React from 'react'
import { CircleDashed } from 'lucide-react'
import { cn } from '@/lib/utils'

type AgentUnverifiableIconProps = React.ComponentProps<typeof CircleDashed>

export function AgentUnverifiableIcon({
  className,
  ...props
}: AgentUnverifiableIconProps): React.JSX.Element {
  return (
    <CircleDashed
      {...props}
      className={cn('text-muted-foreground', className)}
      aria-hidden="true"
    />
  )
}
