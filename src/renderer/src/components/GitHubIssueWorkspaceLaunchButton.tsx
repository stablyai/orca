import React from 'react'
import { ArrowRight, ChevronDown, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { AgentIcon, getAgentCatalog } from '@/lib/agent-catalog'
import { useAgentDetectionTargetForRepo } from '@/hooks/useAgentDetectionTarget'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useAppStore } from '@/store'
import {
  DEFAULT_DISABLED_TUI_AGENTS,
  filterEnabledTuiAgents
} from '../../../shared/tui-agent-selection'
import type { Repo, TuiAgent } from '../../../shared/types'

type GitHubIssueWorkspaceLaunchButtonProps = {
  repo: Repo | null
  onStartDefault: () => void
  onStartWithAgent: (agent: TuiAgent) => void
}

/** Rendered only while the menu is open, so detection stays lazy per row. */
function GitHubIssueLaunchAgentMenuItems({
  repo,
  onStartWithAgent
}: {
  repo: Repo | null
  onStartWithAgent: (agent: TuiAgent) => void
}): React.JSX.Element {
  const target = useAgentDetectionTargetForRepo(repo)
  const { detectedIds, detectionFailed } = useDetectedAgents(target)
  const disabledAgents = useAppStore(
    (s) => s.settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS
  )

  if (!repo || detectionFailed) {
    return (
      <DropdownMenuItem disabled>
        {translate(
          'auto.components.GitHubIssueWorkspaceLaunchButton.9635bbe266',
          'Unable to load agents'
        )}
      </DropdownMenuItem>
    )
  }
  if (detectedIds === null) {
    return (
      <DropdownMenuItem disabled>
        <LoaderCircle className="animate-spin" />
        {translate(
          'auto.components.GitHubIssueWorkspaceLaunchButton.cf532aff14',
          'Detecting agents…'
        )}
      </DropdownMenuItem>
    )
  }

  const enabled = new Set(filterEnabledTuiAgents(detectedIds, disabledAgents))
  const agents = getAgentCatalog().filter((agent) => enabled.has(agent.id))
  if (agents.length === 0) {
    return (
      <DropdownMenuItem disabled>
        {translate(
          'auto.components.GitHubIssueWorkspaceLaunchButton.89f202d990',
          'No agents available'
        )}
      </DropdownMenuItem>
    )
  }
  return (
    <>
      {agents.map((agent) => (
        <DropdownMenuItem key={agent.id} onSelect={() => onStartWithAgent(agent.id)}>
          <AgentIcon agent={agent.id} />
          {agent.label}
        </DropdownMenuItem>
      ))}
    </>
  )
}

export function GitHubIssueWorkspaceLaunchButton({
  repo,
  onStartDefault,
  onStartWithAgent
}: GitHubIssueWorkspaceLaunchButtonProps): React.JSX.Element {
  return (
    <DropdownMenu modal={false}>
      <ButtonGroup className="shrink-0" onClick={(event) => event.stopPropagation()}>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="min-w-[72px] gap-1 bg-background/80 font-semibold"
          data-contextual-tour-target="tasks-start-workspace"
          aria-label={translate(
            'auto.components.GitHubIssueWorkspaceLaunchButton.f20e260a05',
            'Start workspace from issue'
          )}
          onClick={onStartDefault}
        >
          {translate('auto.components.GitHubIssueWorkspaceLaunchButton.e4bb9f1ece', 'Start')}
          <ArrowRight className="size-3" />
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-xs"
                className="bg-background/80"
                aria-label={translate(
                  'auto.components.GitHubIssueWorkspaceLaunchButton.c8a6bec97e',
                  'Choose an agent for this workspace'
                )}
              >
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>
            {translate(
              'auto.components.GitHubIssueWorkspaceLaunchButton.c8a6bec97e',
              'Choose an agent for this workspace'
            )}
          </TooltipContent>
        </Tooltip>
      </ButtonGroup>
      <DropdownMenuContent
        align="end"
        className="min-w-[190px]"
        onClick={(event) => event.stopPropagation()}
      >
        <DropdownMenuLabel>
          {translate(
            'auto.components.GitHubIssueWorkspaceLaunchButton.01be61ba14',
            'Start with agent'
          )}
        </DropdownMenuLabel>
        <GitHubIssueLaunchAgentMenuItems repo={repo} onStartWithAgent={onStartWithAgent} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
