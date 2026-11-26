// How the bots-adoption scenarios' workspaces become `worktree ps` rows and terminal transcripts.
import { composeWorktreeId } from '../../shared/worktree/id'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
// Read once, so every row of a run shares one clock.
const NOW = Date.now()

export type AdoptionAgent = {
  agent?: 'claude' | 'codex'
  state: 'working' | 'done' | 'waiting' | 'blocked'
  asked: string
  said: string
  /** How long ago it last changed. */
  ago: number
  /** Earlier exchanges, oldest first, as its terminal still shows them. */
  earlier?: { asked: string; said: string }[]
}

export type AdoptionFixture = {
  repoId: string
  repo: string
  name: string
  branch?: string
  host?: string
  /** How long ago the workspace was last active. */
  ago: number
  pr?: {
    number: number
    state: 'open' | 'merged' | 'closed' | 'draft'
    title: string
    checks?: string
  }
  linear?: string
  /** The bot it is already under. */
  bot?: string
  agents?: (AdoptionAgent & { handle: string })[]
  /** The workspace (by name, same project) whose agent started this one. */
  parent?: string
  /** Recent commits on its branch, oldest first. */
  commits?: { message: string; ago: number }[]
}

function idFor(input: Pick<AdoptionFixture, 'repoId' | 'repo'>, name: string): string {
  return composeWorktreeId(input.repoId, `/Users/owner/workspaces/${input.repo}/${name}`)
}

/** A row as `worktree.ps` answers it; `commits` makes the harness write a real repository for it.
 *  `fixtures` are the world's others, for the workspaces this one started. */
export function adoptionRow(
  input: AdoptionFixture,
  fixtures: readonly AdoptionFixture[] = []
): Record<string, unknown> {
  const path = `/Users/owner/workspaces/${input.repo}/${input.name}`
  const branch = input.branch ?? input.name
  const agents = input.agents ?? []
  return {
    workspaceKind: 'git',
    worktreeId: composeWorktreeId(input.repoId, path),
    repoId: input.repoId,
    hostId: input.host ?? 'local',
    repo: input.repo,
    path,
    branch: `refs/heads/${branch}`,
    displayName: input.name,
    isArchived: false,
    isMainWorktree: false,
    hasHostSidebarActivity: false,
    parentWorktreeId: input.parent ? idFor(input, input.parent) : null,
    childWorktreeIds: fixtures
      .filter((other) => other.parent === input.name && other.repoId === input.repoId)
      .map((other) => idFor(other, other.name)),
    workspaceStatus: 'in-progress',
    sortOrder: 0,
    lastActivityAt: NOW - input.ago,
    linkedIssue: null,
    linkedPR: input.pr
      ? {
          number: input.pr.number,
          state: input.pr.state,
          title: input.pr.title,
          url: `https://github.com/stablyai/orca/pull/${input.pr.number}`,
          ...(input.pr.checks ? { checksStatus: input.pr.checks } : {})
        }
      : null,
    linkedLinearIssue: input.linear ?? null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    comment: '',
    isPinned: false,
    isActive: false,
    unread: false,
    liveTerminalCount: agents.length,
    hasAttachedPty: agents.length > 0,
    unverifiableTerminalCount: 0,
    lastOutputAt: agents.length ? NOW - input.ago : null,
    preview: '',
    status: agents.some((agent) => agent.state === 'working') ? 'working' : 'active',
    ...(input.bot ? { bot: input.bot } : {}),
    agents: agents.map((agent) => ({
      paneKey: `tab-${agent.handle}:leaf-1`,
      address: agent.handle,
      parentPaneKey: null,
      state: agent.state,
      agentType: agent.agent ?? 'claude',
      prompt: agent.asked,
      taskTitle: null,
      displayName: null,
      lastAssistantMessage: agent.said,
      toolName: null,
      toolInput: null,
      interrupted: false,
      stateStartedAt: NOW - agent.ago,
      updatedAt: NOW - agent.ago,
      hasLivePty: true
    })),
    ...(input.commits
      ? {
          commits: input.commits.map((commit) => ({
            message: commit.message,
            at: NOW - commit.ago
          }))
        }
      : {})
  }
}

/** What each agent's terminal still shows: its earlier exchanges, then the last. */
export function adoptionTranscripts(fixtures: AdoptionFixture[]): Record<string, string> {
  const entries = fixtures.flatMap((fixture) =>
    (fixture.agents ?? []).map((agent): [string, string] => [
      agent.handle,
      [...(agent.earlier ?? []), { asked: agent.asked, said: agent.said }]
        .map((exchange) => `> ${exchange.asked}\n\n${exchange.said}\n`)
        .join('\n')
    ])
  )
  return Object.fromEntries(entries)
}
