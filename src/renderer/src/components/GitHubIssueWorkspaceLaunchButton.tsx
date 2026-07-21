import React, { useCallback, useEffect, useRef, useState } from 'react'
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
import { translate } from '@/i18n/i18n'
import { AgentIcon, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { loadGitHubIssueLaunchAgents } from '@/lib/github-issue-launch-agents'
import type { Repo, TuiAgent } from '../../../shared/types'

type GitHubIssueWorkspaceLaunchButtonProps = {
  repo: Repo | null
  onStartDefault: () => void
  onStartWithAgent: (agent: TuiAgent) => void
}

type AgentLoadState =
  | { status: 'idle' | 'loading' | 'error'; agents: AgentCatalogEntry[] }
  | { status: 'ready'; agents: AgentCatalogEntry[] }

export function GitHubIssueWorkspaceLaunchButton({
  repo,
  onStartDefault,
  onStartWithAgent
}: GitHubIssueWorkspaceLaunchButtonProps): React.JSX.Element {
  const [agentState, setAgentState] = useState<AgentLoadState>({ status: 'idle', agents: [] })
  const loadRequestRef = useRef(0)

  useEffect(
    () => () => {
      loadRequestRef.current += 1
    },
    []
  )

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        return
      }
      const requestId = loadRequestRef.current + 1
      loadRequestRef.current = requestId
      setAgentState({ status: 'loading', agents: [] })
      void loadGitHubIssueLaunchAgents(repo).then(
        (agents) => {
          if (loadRequestRef.current === requestId) {
            setAgentState({ status: 'ready', agents })
          }
        },
        () => {
          if (loadRequestRef.current === requestId) {
            setAgentState({ status: 'error', agents: [] })
          }
        }
      )
    },
    [repo]
  )

  return (
    <DropdownMenu modal={false} onOpenChange={handleOpenChange}>
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
            title={translate(
              'auto.components.GitHubIssueWorkspaceLaunchButton.c8a6bec97e',
              'Choose an agent for this workspace'
            )}
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
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
        {agentState.status === 'loading' || agentState.status === 'idle' ? (
          <DropdownMenuItem disabled>
            <LoaderCircle className="animate-spin" />
            {translate(
              'auto.components.GitHubIssueWorkspaceLaunchButton.cf532aff14',
              'Detecting agents…'
            )}
          </DropdownMenuItem>
        ) : agentState.status === 'error' ? (
          <DropdownMenuItem disabled>
            {translate(
              'auto.components.GitHubIssueWorkspaceLaunchButton.9635bbe266',
              'Unable to load agents'
            )}
          </DropdownMenuItem>
        ) : agentState.agents.length === 0 ? (
          <DropdownMenuItem disabled>
            {translate(
              'auto.components.GitHubIssueWorkspaceLaunchButton.9f82809820',
              'No enabled agents detected'
            )}
          </DropdownMenuItem>
        ) : (
          agentState.agents.map((agent) => (
            <DropdownMenuItem key={agent.id} onSelect={() => onStartWithAgent(agent.id)}>
              <AgentIcon agent={agent.id} />
              {agent.label}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
