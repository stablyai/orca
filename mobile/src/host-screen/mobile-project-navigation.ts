import { translate } from '../i18n/mobile-i18n'
import { z } from 'zod'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/structured-agent-session-projection'
import { getWorktreeRowIdentity } from '../worktree/worktree-host-row-identity'
import type { Worktree } from '../worktree/workspace-list-types'

const OWNER_ROLES = new Set([
  'owner',
  'lead',
  'coordinator',
  '주책임',
  '총괄',
  '責任者',
  '负责人',
  '負責人'
])
const ARCHIVED_ROLES = new Set(['archived', 'history', '이전기록', '履歴', '归档', '封存'])
const SESSION_ROLES = new Set([
  ...OWNER_ROLES,
  ...ARCHIVED_ROLES,
  'worker',
  'reviewer',
  '담당',
  '구현',
  '검토'
])

export const projectSessionInventorySchema = z.object({
  snapshots: z.array(
    z.object({
      worktree: z.string(),
      agentSessionsUnverifiable: z.literal(true).optional(),
      tabs: z.array(
        z.object({
          type: z.string(),
          id: z.string(),
          title: z.string().optional(),
          sessionId: z.string().optional(),
          agent: z.string().optional()
        })
      )
    })
  )
})
export type ProjectSessionSnapshot = z.infer<
  typeof projectSessionInventorySchema
>['snapshots'][number]
export type ProjectQuickFilter = 'all' | 'attention' | 'working' | 'unread'
export type ProjectSession = {
  id: string
  title: string
  task: string
  role: string
  owner: boolean
  archived: boolean
  paneKey: string
  agent: string
  status: string
  attention: boolean
  working: boolean
}
export type MobileProject = {
  key: string
  category: string
  title: string
  worktree: Worktree
  sessions: ProjectSession[]
}

export function projectNameParts(name: string, sharedCategories: ReadonlySet<string> = new Set()) {
  const segments = name.split('_').map((part) => part.trim())
  const category = segments[0]
  if (!category || segments.length < 2 || segments.some((part) => !part)) {
    return null
  }
  const suffix = segments.at(-1) ?? ''
  const hasRole = segments.length >= 3 && SESSION_ROLES.has(suffix.toLowerCase())
  const structuredPrefix =
    /^[\p{Lu}\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
      category
    ) || segments.slice(1).some((part) => /^[\p{Lu}]/u.test(part))
  if (!structuredPrefix && !hasRole && !sharedCategories.has(category)) {
    return null
  }
  return {
    category,
    task: segments.slice(1, hasRole ? -1 : undefined).join('_'),
    role: hasRole ? suffix : ''
  }
}

export function sharedProjectCategories(worktrees: readonly Worktree[]): ReadonlySet<string> {
  const counts = new Map<string, number>()
  for (const row of worktrees) {
    const categories = new Set(
      [row.displayName, row.repo].flatMap((name) => {
        const parts = projectNameParts(name)
        return parts ? [parts.category] : []
      })
    )
    for (const category of categories) {
      counts.set(category, (counts.get(category) ?? 0) + 1)
    }
    for (const agent of row.agents ?? []) {
      const parts = projectNameParts(agent.displayName ?? '')
      if (parts?.role) {
        counts.set(parts.category, 2)
      }
    }
  }
  return new Set([...counts].filter(([, count]) => count >= 2).map(([category]) => category))
}

export function hasCategorizedProjects(worktrees: readonly Worktree[]): boolean {
  const categories = sharedProjectCategories(worktrees)
  return worktrees.some((row) => Boolean(projectNameParts(row.displayName, categories)))
}

function sessionStatus(row: RuntimeWorktreeAgentRow | undefined, live: boolean) {
  if (!live) {
    return {
      status: translate(
        'hostScreen.projectNavigation.statusCheckingConnection',
        'Checking connection'
      ),
      attention: false,
      working: false
    }
  }
  if (row?.state === 'blocked' || row?.interrupted || row?.mainAgent?.outcome === 'failure') {
    return {
      status: translate('hostScreen.projectNavigation.statusNeedsAttention', 'Needs attention'),
      attention: true,
      working: false
    }
  }
  if (row?.state === 'working') {
    return {
      status: translate('hostScreen.projectNavigation.statusWorking', 'Working'),
      attention: false,
      working: true
    }
  }
  if (row?.state === 'done') {
    return {
      status: translate('hostScreen.projectNavigation.statusDone', 'Response complete'),
      attention: false,
      working: false
    }
  }
  return {
    status: row
      ? translate('hostScreen.projectNavigation.statusIdle', 'Idle')
      : translate('hostScreen.projectNavigation.statusUnknown', 'Status unknown'),
    attention: false,
    working: false
  }
}

export function buildMobileProject(
  worktree: Worktree,
  snapshot: ProjectSessionSnapshot | undefined,
  live: boolean,
  categories: ReadonlySet<string> = new Set()
): MobileProject {
  const displayParts = projectNameParts(worktree.displayName, categories)
  const parts = displayParts ?? projectNameParts(worktree.repo, categories)
  const agents = worktree.agents ?? []
  const sessions: ProjectSession[] = (snapshot?.tabs ?? []).flatMap((tab) => {
    if (tab.type !== 'agent-session' || !tab.sessionId) {
      return []
    }
    const paneKey = structuredAgentSessionPaneKey(
      structuredAgentSessionTabId(tab.sessionId),
      tab.sessionId
    )
    const agent = agents.find((row) => row.paneKey === paneKey)
    const title =
      tab.title || agent?.displayName || translate('hostScreen.projectNavigation.chat', 'Chat')
    const name = projectNameParts(title)
    const role = name?.role || translate('hostScreen.projectNavigation.chat', 'Chat')
    return [
      {
        id: tab.sessionId,
        title,
        task: name?.task || title,
        role,
        owner: name?.category === parts?.category && OWNER_ROLES.has(role.toLowerCase()),
        archived: ARCHIVED_ROLES.has(role.toLowerCase()),
        paneKey,
        agent: tab.agent || agent?.agentType || '',
        ...sessionStatus(agent, live)
      }
    ]
  })
  for (const agent of agents) {
    if (sessions.some((s) => s.paneKey === agent.paneKey) || agent.parentPaneKey) {
      continue
    }
    if (
      snapshot &&
      !snapshot.agentSessionsUnverifiable &&
      agent.state !== 'working' &&
      agent.state !== 'blocked'
    ) {
      continue
    }
    const title =
      agent.displayName ||
      agent.taskTitle ||
      translate('hostScreen.projectNavigation.agentChat', '{{agent}} chat', {
        agent: agent.agentType
      })
    const name = projectNameParts(title)
    sessions.push({
      id: agent.paneKey,
      title,
      task: name?.task || title,
      role: name?.role || translate('hostScreen.projectNavigation.chat', 'Chat'),
      owner: false,
      archived: ARCHIVED_ROLES.has(name?.role.toLowerCase() ?? ''),
      paneKey: agent.paneKey,
      agent: agent.agentType || '',
      ...sessionStatus(agent, live)
    })
  }
  sessions.sort(
    (a, b) =>
      Number(a.archived) - Number(b.archived) ||
      Number(b.owner) - Number(a.owner) ||
      Number(b.attention) - Number(a.attention) ||
      Number(b.working) - Number(a.working)
  )
  return {
    key: getWorktreeRowIdentity(worktree),
    category: parts?.category || translate('hostScreen.projectNavigation.otherCategory', 'Other'),
    title: displayParts?.task || worktree.displayName || worktree.repo,
    worktree,
    sessions
  }
}

export function projectMatchesFilter(project: MobileProject, filter: ProjectQuickFilter): boolean {
  if (filter === 'unread') {
    return project.worktree.unread
  }
  if (filter === 'working') {
    return project.sessions.some((s) => !s.archived && s.working)
  }
  if (filter === 'attention') {
    return project.sessions.some((s) => !s.archived && s.attention)
  }
  return true
}

export function sortMobileProjects(projects: readonly MobileProject[]): MobileProject[] {
  return [...projects].sort((a, b) => {
    return (
      a.category.localeCompare(b.category) ||
      (a.worktree.manualOrder ?? a.worktree.sortOrder ?? 0) -
        (b.worktree.manualOrder ?? b.worktree.sortOrder ?? 0) ||
      a.key.localeCompare(b.key)
    )
  })
}

export function projectPrimarySession(project: MobileProject): ProjectSession | undefined {
  const owners = project.sessions.filter((s) => s.owner && !s.archived)
  return owners.length === 1 ? owners[0] : undefined
}
