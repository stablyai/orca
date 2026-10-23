import type { RuntimeWorktreePsSummary } from '../../shared/runtime-worktree-contracts'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { TuiAgent } from '../../shared/tui-agent'

/**
 * Projects the worktree/agent roster into spoken-safe entries for the coordinator session.
 * Read-only consumer of the agent status surface — names are deduped with stable numeric
 * suffixes so the user can say "oak two". Worktrees with NO running agent are
 * projected too (paneKey '', state 'idle') so "resume the ci-type-checking-guard agent"
 * has something to resolve against — start_agent wakes those.
 */

export type VoiceRosterEntry = {
  spokenName: string
  worktreeId: string
  repoId: string
  /** Empty string marks an idle worktree (no running agent) — start_agent's territory. */
  paneKey: string
  agentType: string | null
  state: string
  /** When the current state began (ms epoch) — the watchdog ignores states older than
   *  the dispatch they're read for. Absent/0 = age unknown = treat as ancient. */
  stateStartedAt?: number
  taskTitle: string | null
  /** The tool the agent is currently running, when the status surface reports one. */
  toolName: string | null
  /** The worktree's filesystem path — run_command's cwd when this agent is named. */
  worktreePath: string
  /** The worktree's execution host ('local', 'ssh:…', 'runtime:…'); null = absent on the
   *  wire (old hosts never send it) = local. run_command spawns on THIS machine — this
   *  field is what keeps a remote worktree's path from being answered locally. */
  hostId: RuntimeWorktreePsSummary['hostId'] | null
  /** The agent this worktree was created with — start_agent's resume default. Optional on
   *  the wire (old hosts never send it); absent and null both mean "no history". */
  createdWithAgent?: TuiAgent | null
}

/** Idle worktrees are resume candidates, not a census — cap the list, most recent first. */
const IDLE_WORKTREE_LIMIT = 8

function toSpokenBaseName(displayName: string): string {
  const cleaned = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return cleaned.length > 0 ? cleaned : 'agent'
}

/** Branch as a spoken base name — '' when branchless (folder workspaces). */
function toBranchBaseName(branch: string): string {
  const short = branch.replace(/^refs\/heads\//, '')
  return short.trim() === '' ? '' : toSpokenBaseName(short)
}

type RosterRow = {
  base: string
  branchBase: string
  entry: Omit<VoiceRosterEntry, 'spokenName'>
}

export function projectVoiceRoster(summaries: RuntimeWorktreePsSummary[]): VoiceRosterEntry[] {
  const rows: RosterRow[] = []
  for (const summary of summaries) {
    if (summary.isArchived) {
      continue
    }
    for (const agent of summary.agents) {
      rows.push({
        base: toSpokenBaseName(agent.displayName ?? summary.displayName),
        branchBase: toBranchBaseName(summary.branch),
        entry: {
          worktreeId: summary.worktreeId,
          repoId: summary.repoId,
          paneKey: agent.paneKey,
          agentType: agent.agentType,
          state: agent.state,
          stateStartedAt: agent.stateStartedAt,
          taskTitle: agent.taskTitle,
          toolName: agent.toolName,
          worktreePath: summary.path,
          hostId: summary.hostId ?? null,
          createdWithAgent: summary.createdWithAgent ?? null
        }
      })
    }
  }
  const idle = summaries
    .filter((summary) => !summary.isArchived && summary.agents.length === 0)
    .sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0))
  for (const summary of idle.slice(0, IDLE_WORKTREE_LIMIT)) {
    rows.push({
      base: toSpokenBaseName(summary.displayName),
      branchBase: toBranchBaseName(summary.branch),
      entry: {
        worktreeId: summary.worktreeId,
        repoId: summary.repoId,
        paneKey: '',
        agentType: null,
        state: 'idle',
        taskTitle: null,
        toolName: null,
        worktreePath: summary.path,
        hostId: summary.hostId ?? null,
        createdWithAgent: summary.createdWithAgent ?? null
      }
    })
  }
  // A bare numeric suffix ("main 2") matches nothing on the user's screen — live: two
  // worktrees both displayed "main", and the coordinator could not even verify a switch
  // because both sides self-reported "main". The sidebar disambiguates with the branch,
  // so a collided group resolves to branch names — but only when branches fully separate
  // the group (three "oak" worktrees sharing one branch must NOT all rename to "main");
  // the numeric suffix stays the last resort.
  const groups = new Map<string, RosterRow[]>()
  for (const row of rows) {
    const group = groups.get(row.base) ?? []
    group.push(row)
    groups.set(row.base, group)
  }
  const seenBases = new Map<string, number>()
  const entries: VoiceRosterEntry[] = []
  for (const [base, group] of groups) {
    const branchBases = new Set(group.map((row) => row.branchBase))
    const branchDisambiguates =
      group.length > 1 && branchBases.size === group.length && !branchBases.has('')
    for (const row of group) {
      const resolved = branchDisambiguates ? row.branchBase : base
      const seen = seenBases.get(resolved) ?? 0
      seenBases.set(resolved, seen + 1)
      entries.push({ ...row.entry, spokenName: seen === 0 ? resolved : `${resolved} ${seen + 1}` })
    }
  }
  return entries
}

/** Task specs arrive whole; the roster line stays scannable. */
const TASK_TITLE_LIMIT = 80

/**
 * run_command and the installed-agent scan operate on THIS machine. A remote entry's
 * path means nothing here — running locally would answer for the wrong repository
 * (docs/reference/ssh-execution-boundary.md: never silently substitute the client).
 */
export function isClientLocalVoiceEntry(entry: VoiceRosterEntry): boolean {
  return entry.hostId == null || entry.hostId === LOCAL_EXECUTION_HOST_ID
}

/** The roster as spoken/text context for the coordinator model. */
export function formatVoiceRosterForInstructions(entries: VoiceRosterEntry[]): string {
  const live = entries.filter((entry) => entry.paneKey !== '')
  const idle = entries.filter((entry) => entry.paneKey === '')
  const sections: string[] = []
  if (live.length > 0) {
    const lines = live.map((entry) => {
      // State FIRST and always: a finished agent keeps its task title, so
      // title-as-activity read as "still working" forever — live: a done agent answered
      // "still in progress" to "is it done?" twice because the state never reached the page.
      const task = entry.taskTitle ? ` — ${truncateTaskTitle(entry.taskTitle)}` : ''
      const tool = entry.toolName ? `, running ${entry.toolName}` : ''
      // The model plans from this line; a remote host changes which tools apply.
      const host = isClientLocalVoiceEntry(entry) ? '' : ', remote host'
      return `- "${entry.spokenName}" (${entry.agentType ?? 'agent'}, ${entry.state}${task}${tool}${host})`
    })
    sections.push(`Currently running agents:\n${lines.join('\n')}`)
  }
  if (idle.length > 0) {
    sections.push(
      `Idle worktrees with no running agent (start_agent wakes one with a task): ${idle.map((entry) => entry.spokenName).join(', ')}`
    )
  }
  return sections.length > 0 ? sections.join('\n') : 'No agents are currently running.'
}

function truncateTaskTitle(title: string): string {
  return title.length > TASK_TITLE_LIMIT ? `${title.slice(0, TASK_TITLE_LIMIT - 1)}…` : title
}
