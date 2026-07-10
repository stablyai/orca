import React from 'react'
import { GitCommitHorizontal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { WorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'

type DetachedHeadDisplay = Extract<WorktreeGitIdentityDisplay, { kind: 'detached' }>

type DetachedHeadBadgeProps = {
  display: DetachedHeadDisplay
  label?: 'sidebar' | 'source-control'
  side?: React.ComponentProps<typeof TooltipContent>['side']
  className?: string
}

export function DetachedHeadBadge({
  display,
  label = 'source-control',
  side = 'right',
  className
}: DetachedHeadBadgeProps): React.JSX.Element {
  const visibleLabel = label === 'sidebar' ? display.sidebarLabel : display.sourceControlLabel

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn(
            'h-[18px] shrink-0 gap-1 rounded px-1.5 text-[10px] font-medium leading-none',
            'border-[color:color-mix(in_srgb,var(--git-decoration-modified)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--git-decoration-modified)_8%,transparent)] text-[color:var(--git-decoration-modified)]',
            className
          )}
        >
          <GitCommitHorizontal className="size-2.5" />
          {visibleLabel}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side={side} sideOffset={8}>
        {display.tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
