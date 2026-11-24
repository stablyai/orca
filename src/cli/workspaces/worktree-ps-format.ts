// `orca worktree ps` as text: per workspace, what an agent reading it needs to tell what the work is
// and where it stands: its name, project, owner bot, PR and issue, and each agent's last exchange.
import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsResult,
  RuntimeWorktreePsSummary
} from '../../shared/worktree/catalog/runtime-worktree-contracts'
import type { BotRosterEntry } from '../../shared/bot-roster'
import {
  formatListingHostScope,
  type WithAnnotatedHostScope
} from '../hosts/omitted-host-scope-selectors'
import { formatWorktreePsTerminalFields } from './worktree-ps-terminal-verdict'
import { formatWorktreePsProgramStatus } from './worktree-ps-program-status'
import { formatAddressLines, formatParentLine, type WorkspaceAnnotation } from './workspace-address'
import { workspaceAnnotationOf } from './workspace-format'

type PsRow = RuntimeWorktreePsSummary & Partial<WorkspaceAnnotation>

const EXCHANGE_CHARS = 240
/** Children shown by name on a parent's row; the rest are counted. */
const CHILDREN_NAMED = 3

const AGENT_STATE_WORDS: Record<string, string> = {
  working: 'working',
  blocked: 'blocked on an approval',
  waiting: 'waiting for an answer',
  // A finished turn: the agent is open, at its prompt.
  done: 'idle'
}

/** One line, cut to what a listing shows of an exchange. */
export function oneLine(text: string | null | undefined): string | null {
  const flat = text?.replace(/\s+/g, ' ').trim()
  if (!flat) {
    return null
  }
  return flat.length > EXCHANGE_CHARS ? `${flat.slice(0, EXCHANGE_CHARS - 1)}…` : flat
}

export function ago(at: number | undefined, now: number): string | null {
  if (!at) {
    return null
  }
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

export function agentStateWords(state: string): string {
  return AGENT_STATE_WORDS[state] ?? state
}

/** The agent a hand-off or message goes to: the open one most recently active. */
export function worktreePsOpenAgent(row: RuntimeWorktreePsSummary | undefined) {
  return [...(row?.agents ?? [])]
    .filter((agent) => agent.address)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
}

/** When anything last happened there: the workspace's own clock or an agent's latest update. */
export function worktreePsLastActive(row: RuntimeWorktreePsSummary): number {
  return Math.max(row.lastActivityAt ?? 0, ...row.agents.map((agent) => agent.updatedAt ?? 0))
}

// The branch and PR name the work it was made for; a finished PR says so, as its agents may have moved on.
function linkLine(row: RuntimeWorktreePsSummary): string | null {
  const parts: string[] = []
  const pr = row.linkedPR
  if (pr) {
    const title = pr.title ? ` "${oneLine(pr.title)}"` : ''
    const checks = pr.checksStatus ? `, checks ${pr.checksStatus}` : ''
    parts.push(`PR #${pr.number} ${pr.state.toLowerCase()}${title}${checks}`)
  }
  if (row.linkedLinearIssue) {
    parts.push(`Linear ${row.linkedLinearIssue}`)
  }
  if (row.linkedIssue !== null) {
    parts.push(`issue #${row.linkedIssue}`)
  }
  if (row.workspaceKind !== 'folder-workspace' && row.branch) {
    parts.unshift(`branch ${row.branch}`)
  }
  if (parts.length === 0) {
    return null
  }
  const finished = pr && !['open', 'draft'].includes(pr.state.toLowerCase())
  return `${finished ? 'earlier work: ' : ''}${parts.join(' · ')}`
}

function agentLines(agent: RuntimeWorktreePsSummary['agents'][number], now: number): string[] {
  // A live terminal Orca has no handle for (a row restored after a restart) can't be messaged yet.
  const state =
    !agent.address && agent.hasLivePty
      ? 'open, no handle yet'
      : (AGENT_STATE_WORDS[agent.state] ?? agent.state)
  const when = ago(agent.updatedAt, now)
  const address = agent.address ? ` (--terminal ${agent.address})` : ''
  const asked = oneLine(agent.prompt)
  const said = oneLine(agent.lastAssistantMessage)
  return [
    `agent ${agent.agentType ?? 'unknown'} ${state}${when ? `, ${when}` : ''}${address}`,
    ...(asked ? [`  last asked: ${asked}`] : []),
    ...(said ? [`  last said: ${said}`] : [])
  ]
}

// Which workspace started which: a coordinator's own exchanges rarely say what its children work on.
function lineageLines(row: RuntimeWorktreePsSummary, names: ReadonlyMap<string, string>): string[] {
  // The sidebar's precedence: worktree, then folder workspace, then another machine.
  const parent =
    (row.parentWorktreeId ? names.get(row.parentWorktreeId) : undefined) ??
    row.workspaceLineage?.parentWorkspaceKey ??
    (row.crossStoreParent
      ? `${row.crossStoreParent.parent.workspaceKey} on another machine`
      : undefined)
  const children = row.childWorktreeIds ?? []
  const named = children.flatMap((id) => names.get(id) ?? []).slice(0, CHILDREN_NAMED)
  const more = children.length - named.length
  const list = named.length ? `: ${named.join(', ')}${more ? ` and ${more} more` : ''}` : ''
  return [
    ...(parent ? [`under ${parent}`] : []),
    ...(children.length
      ? [`started ${children.length} ${children.length === 1 ? 'workspace' : 'workspaces'}${list}`]
      : [])
  ]
}

function formatRow(row: PsRow, now: number, names: ReadonlyMap<string, string>): string {
  const owner = row.botHome ? `home of bot ${row.bot}` : row.bot ? `under bot ${row.bot}` : null
  const active = ago(worktreePsLastActive(row), now)
  const header = [
    `${row.displayName || row.branch}`,
    `${row.repo}${row.workspaceKind === 'folder-workspace' ? ' (folder)' : ''}`,
    `host=${row.hostId ?? 'unverifiable'}`,
    ...(active ? [`active ${active}`] : []),
    ...(owner ? [owner] : [])
  ].join(' · ')
  const links = linkLine(row)
  const agents: readonly RuntimeWorktreeAgentRow[] = row.agents
  const annotation = workspaceAnnotationOf(row)
  return [
    header,
    `--worktree id:${row.worktreeId}${row.workspaceKind === 'folder-workspace' ? `  ${row.path}` : ''}${annotation ? `${formatParentLine(annotation)}${formatAddressLines(annotation)}` : ''}`,
    ...lineageLines(row, names),
    // What its agents are doing now leads; a branch's PR can be long merged while they moved on.
    ...(agents.length ? agents.flatMap((agent) => agentLines(agent, now)) : ['no agent open']),
    ...(links ? [links] : []),
    `${formatWorktreePsTerminalFields(row)}  unread:${row.unread ? 'yes' : 'no'}${formatWorktreePsProgramStatus(row.agents)}`,
    // An agent's own words say more than its terminal's last line (often a spinner or an error).
    ...(row.preview && !agents.some((agent) => agent.lastAssistantMessage)
      ? [`preview: ${row.preview}`]
      : [])
  ].join('\n')
}

function formatOtherBots(bots: readonly BotRosterEntry[]): string {
  return [
    'Other bots, and what each is for:',
    ...bots.map((bot) => `- ${bot.name}: ${bot.specialty ?? 'not set up yet'}`)
  ].join('\n')
}

export function formatWorktreePs(
  result: WithAnnotatedHostScope<
    Omit<RuntimeWorktreePsResult, 'worktrees'> & { worktrees: PsRow[] }
  >,
  now = Date.now(),
  otherBots: readonly BotRosterEntry[] = []
): string {
  const scope = formatListingHostScope(result.hostScope)
  if (result.worktrees.length === 0) {
    return `No worktrees found.\n${scope}`
  }
  const names = new Map(
    result.worktrees.map((row) => [row.worktreeId, row.displayName || row.branch])
  )
  const body = [
    ...result.worktrees.map((row) => formatRow(row, now, names)),
    ...(otherBots.length ? [formatOtherBots(otherBots)] : [])
  ].join('\n\n')
  const bodyWithScope = `${body}\n\n${scope}`
  return result.truncated
    ? `${bodyWithScope}\ntruncated: showing ${result.worktrees.length} of ${result.totalCount}`
    : bodyWithScope
}
