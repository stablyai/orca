import { ArrowRight, Layers } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { JiraIssue } from '../../../shared/jira-types'
import type { Worktree } from '../../../shared/worktree/types'

export function JiraLinkedWorkspaceAction({
  issue,
  workspaces,
  onOpenWorkspace,
  onStartWorkspace
}: {
  issue: JiraIssue
  workspaces: readonly Worktree[]
  onOpenWorkspace: (workspace: Worktree) => void
  onStartWorkspace: (issue: JiraIssue) => void
}): React.JSX.Element {
  const label =
    workspaces.length === 1
      ? translate('jira.workspace.single', '1 workspace linked to {{key}}', { key: issue.key })
      : translate('jira.workspace.count', '{{count}} workspaces linked to {{key}}', {
          count: workspaces.length,
          key: issue.key
        })
  const trigger = (
    <Button
      variant="ghost"
      size="xs"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
      }}
    >
      <Layers className="size-3.5" />
      <span>{workspaces.length}</span>
    </Button>
  )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        {workspaces.map((workspace) => (
          <DropdownMenuItem key={workspace.id} onSelect={() => onOpenWorkspace(workspace)}>
            <Layers className="size-3.5" />
            <span className="min-w-0 truncate">
              {workspace.displayName || workspace.branch || workspace.path}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onStartWorkspace(issue)}>
          <ArrowRight className="size-3.5" />
          {translate('jira.workspace.startAnother', 'Start new workspace')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
