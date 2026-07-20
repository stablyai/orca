import React from 'react'
import { Layers } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type GitButlerManagedBadgeProps = {
  side?: React.ComponentProps<typeof TooltipContent>['side']
  className?: string
}

export function GitButlerManagedBadge({
  side = 'right',
  className
}: GitButlerManagedBadgeProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Why: neutral/informational tone (muted token, not warning red) — being
            on a GitButler workspace is a normal supported state, not an error. */}
        <Badge
          variant="outline"
          className={cn(
            'h-[18px] shrink-0 gap-1 rounded px-1.5 text-[10px] font-medium leading-none',
            'border-border bg-muted/40 text-muted-foreground',
            className
          )}
        >
          <Layers className="size-2.5" />
          GitButler
        </Badge>
      </TooltipTrigger>
      {/* Why: detection covers both gitbutler/workspace and the legacy
          gitbutler/integration branch, so the copy names neither explicitly. */}
      <TooltipContent side={side} sideOffset={8}>
        This repo is managed by GitButler. Orca&apos;s Source Control acts on the checked-out
        GitButler workspace branch, not your virtual branches.
      </TooltipContent>
    </Tooltip>
  )
}
