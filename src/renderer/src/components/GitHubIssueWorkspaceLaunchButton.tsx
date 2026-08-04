import React, { useEffect, useRef, useState } from 'react'
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
import { AgentIcon, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { loadGitHubIssueLaunchAgents } from '@/lib/github-issue-launch-agents'
import type { Repo, TuiAgent } from '../../../shared/types'

type GitHubIssueWorkspaceLaunchButtonProps = {
  repo: Repo | null
  onStartDefault: () => void
  onStartWithAgent: (agent: TuiAgent) => void
}

type AgentLoadState =
  | { repoKey: string; status: 'idle' | 'loading' | 'error'; agents: AgentCatalogEntry[] }
  | { repoKey: string; status: 'ready'; agents: AgentCatalogEntry[] }

export function GitHubIssueWorkspaceLaunchButton({
  repo,
  onStartDefault,
  onStartWithAgent
}: GitHubIssueWorkspaceLaunchButtonProps): React.JSX.Element {
  const repoKey = `${repo?.id ?? ''}:${repo?.executionHostId ?? repo?.connectionId ?? ''}`
  const [agentState, setAgentState] = useState<AgentLoadState>({
    repoKey,
    status: 'idle',
    agents: []
  })
  const visibleAgentState: AgentLoadState =
    agentState.repoKey === repoKey ? agentState : { repoKey, status: 'idle', agents: [] }
  const [menuOpen, setMenuOpen] = useState(false)
  // Why: reopening, switching repositories, or unmounting must invalidate late detection results.
  const loadRequestRef = useRef(0)
  const repoRef = useRef(repo)
  repoRef.current = repo

  useEffect(() => {
    const requestId = loadRequestRef.current + 1
    loadRequestRef.current = requestId
    if (menuOpen) {
      setAgentState({ repoKey, status: 'loading', agents: [] })
      void loadGitHubIssueLaunchAgents(repoRef.current).then(
        (agents) => {
          if (loadRequestRef.current === requestId) {
            setAgentState({ repoKey, status: 'ready', agents })
          }
        },
        () => {
          if (loadRequestRef.current === requestId) {
            setAgentState({ repoKey, status: 'error', agents: [] })
          }
        }
      )
    }
    return () => {
      loadRequestRef.current += 1
    }
  }, [menuOpen, repoKey])

  return (
    <DropdownMenu modal={false} onOpenChange={setMenuOpen}>
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
        {visibleAgentState.status === 'loading' || visibleAgentState.status === 'idle' ? (
          <DropdownMenuItem disabled>
            <LoaderCircle className="animate-spin" />
            {translate(
              'auto.components.GitHubIssueWorkspaceLaunchButton.cf532aff14',
              'Detecting agents…'
            )}
          </DropdownMenuItem>
        ) : visibleAgentState.status === 'error' ? (
          <DropdownMenuItem disabled>
            {translate(
              'auto.components.GitHubIssueWorkspaceLaunchButton.9635bbe266',
              'Unable to load agents'
            )}
          </DropdownMenuItem>
        ) : visibleAgentState.agents.length === 0 ? (
          <DropdownMenuItem disabled>
            {translate(
              'auto.components.GitHubIssueWorkspaceLaunchButton.89f202d990',
              'No agents available'
            )}
          </DropdownMenuItem>
        ) : (
          visibleAgentState.agents.map((agent) => (
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
