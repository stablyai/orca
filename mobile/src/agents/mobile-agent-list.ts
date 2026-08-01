import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import {
  agentDisplayLabel,
  agentDotState,
  agentStateLabel,
  type AgentDotState
} from '../worktree/agent-row-display'
import { flattenAgentRowLineage } from '../worktree/agent-row-lineage'
import type { Worktree } from '../worktree/workspace-list-sections'

export type MobileAgentGroupBy = 'status' | 'worktree' | 'repo' | 'agent'
export type MobileAgentVisibilityFilter = 'all' | 'attention'

export type MobileAgentThread = {
  worktreeId: string
  worktreeName: string
  repo: string
  branch: string
  agent: RuntimeWorktreeAgentRow
  dotState: AgentDotState
  lineageDepth: number
  title: string
  subtitle: string
  toolSummary: string | null
  searchText: string
  sortTimestamp: number
}

export type MobileAgentThreadGroup = {
  key: string
  label: string
  threads: MobileAgentThread[]
}

const ATTENTION_STATES: Record<AgentDotState, boolean> = {
  working: true,
  blocked: true,
  waiting: true,
  interrupted: true,
  done: false,
  idle: false
}

const STATUS_ORDER: readonly AgentDotState[] = [
  'working',
  'blocked',
  'waiting',
  'interrupted',
  'done',
  'idle'
]

function makeToolSummary(agent: RuntimeWorktreeAgentRow): string | null {
  if (!agent.toolName) {
    return null
  }
  if (!agent.toolInput) {
    return agent.toolName
  }
  return `${agent.toolName}: ${agent.toolInput}`
}

// Why: subtrees stay contiguous — every descendant renders immediately after
// its lineage root — because MobileAgentThreadRow derives indentation purely
// from lineageDepth. Roots are ordered newest-first; a child with a newer
// stateStartedAt than its parent must not escape above it.
type MobileAgentSubtree = {
  rootTimestamp: number
  threads: MobileAgentThread[]
}

export function buildMobileAgentThreads(
  worktrees: readonly Worktree[],
  now: number
): MobileAgentThread[] {
  const subtrees: MobileAgentSubtree[] = []
  for (const worktree of worktrees) {
    if (!worktree.agents?.length) {
      continue
    }
    const worktreeName = worktree.displayName || worktree.repo
    for (const node of flattenAgentRowLineage(worktree.agents)) {
      const agent = node.row
      const dotState = agentDotState(agent, now)
      const title = agentDisplayLabel(agent, now)
      const subtitle =
        worktreeName === worktree.repo ? worktree.repo : `${worktreeName} · ${worktree.repo}`
      const toolSummary = makeToolSummary(agent)
      const thread: MobileAgentThread = {
        worktreeId: worktree.worktreeId,
        worktreeName,
        repo: worktree.repo,
        branch: worktree.branch,
        agent,
        dotState,
        lineageDepth: node.depth,
        title,
        subtitle,
        toolSummary,
        searchText: [
          title,
          subtitle,
          worktree.branch,
          agent.agentType ?? '',
          agentStateLabel(dotState),
          agent.prompt,
          agent.lastAssistantMessage ?? '',
          agent.toolName ?? '',
          agent.toolInput ?? ''
        ]
          .join(' ')
          .toLowerCase(),
        sortTimestamp: agent.stateStartedAt
      }
      const openSubtree = subtrees[subtrees.length - 1]
      if (node.depth === 0 || !openSubtree) {
        subtrees.push({ rootTimestamp: thread.sortTimestamp, threads: [thread] })
      } else {
        openSubtree.threads.push(thread)
      }
    }
  }
  return subtrees
    .sort((a, b) => b.rootTimestamp - a.rootTimestamp)
    .flatMap((subtree) => subtree.threads)
}

// Membership is decided per thread (unchanged semantics), but each retained
// thread's lineageDepth is rebased to its retained-ancestor count so a row is
// never indented beneath a parent the filter removed. Relies on the
// subtree-contiguous order produced by buildMobileAgentThreads.
export function filterMobileAgentThreads(
  threads: readonly MobileAgentThread[],
  args: { query: string; visibility: MobileAgentVisibilityFilter }
): MobileAgentThread[] {
  const query = args.query.trim().toLowerCase()
  const out: MobileAgentThread[] = []
  // retainedAtDepth[d] = retained ancestors (inclusive) along the original
  // ancestry of the most recent thread seen at original depth d.
  const retainedAtDepth: number[] = []
  for (const thread of threads) {
    const depth = thread.lineageDepth
    const retainedAncestors = depth === 0 ? 0 : (retainedAtDepth[depth - 1] ?? 0)
    const keep =
      (args.visibility !== 'attention' || ATTENTION_STATES[thread.dotState]) &&
      (query.length === 0 || thread.searchText.includes(query))
    retainedAtDepth[depth] = retainedAncestors + (keep ? 1 : 0)
    retainedAtDepth.length = depth + 1
    if (keep) {
      out.push(
        thread.lineageDepth === retainedAncestors
          ? thread
          : { ...thread, lineageDepth: retainedAncestors }
      )
    }
  }
  return out
}

function groupByFirstSeen(
  threads: readonly MobileAgentThread[],
  keyForThread: (thread: MobileAgentThread) => string,
  labelForThread: (thread: MobileAgentThread) => string
): MobileAgentThreadGroup[] {
  const groups: MobileAgentThreadGroup[] = []
  const byKey = new Map<string, MobileAgentThreadGroup>()
  for (const thread of threads) {
    const key = keyForThread(thread)
    let group = byKey.get(key)
    if (!group) {
      group = { key, label: labelForThread(thread), threads: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.threads.push(thread)
  }
  return groups
}

export function groupMobileAgentThreads(
  threads: readonly MobileAgentThread[],
  groupBy: MobileAgentGroupBy
): MobileAgentThreadGroup[] {
  if (groupBy === 'status') {
    return STATUS_ORDER.map((state) => ({
      key: state,
      label: agentStateLabel(state),
      threads: threads.filter((thread) => thread.dotState === state)
    })).filter((group) => group.threads.length > 0)
  }
  if (groupBy === 'worktree') {
    return groupByFirstSeen(
      threads,
      (thread) => thread.worktreeId,
      (thread) => thread.worktreeName
    )
  }
  if (groupBy === 'repo') {
    return groupByFirstSeen(
      threads,
      (thread) => thread.repo,
      (thread) => thread.repo
    )
  }
  return groupByFirstSeen(
    threads,
    (thread) => thread.agent.agentType ?? 'unknown',
    (thread) => thread.agent.agentType ?? 'unknown'
  )
}
