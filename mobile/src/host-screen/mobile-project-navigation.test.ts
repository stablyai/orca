import { describe, expect, it } from 'vitest'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/structured-agent-session-projection'
import type { Worktree } from '../worktree/workspace-list-types'
import {
  buildMobileProject,
  hasCategorizedProjects,
  projectNameParts,
  projectPrimarySession,
  projectMatchesFilter,
  sortMobileProjects,
  projectSessionInventorySchema,
  type ProjectSessionSnapshot
} from './mobile-project-navigation'
import { notificationPaneTab } from '../session/notification-pane-tab'

function row(name = 'Frontend_Auth', overrides: Partial<Worktree> = {}): Worktree {
  return {
    worktreeId: 'repo::/portfolio',
    repoId: 'repo',
    repo: name,
    displayName: name,
    path: '/portfolio',
    branch: 'main',
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...overrides
  }
}
function snapshot(titles: string[]): ProjectSessionSnapshot {
  return {
    worktree: 'repo::/portfolio',
    tabs: titles.map((title, index) => ({
      type: 'agent-session',
      id: `agent-session:chat-${index}`,
      title,
      sessionId: `chat-${index}`,
      agent: 'codex'
    }))
  }
}

describe('mobile project navigation boundaries', () => {
  it('keeps ordinary repositories flat and recognizes structured workspace names', () => {
    expect(
      hasCategorizedProjects(
        ['orca', 'my_project', 'my_other_repo', 'web-app', 'node_modules'].map((name) => row(name))
      )
    ).toBe(false)
    expect(
      hasCategorizedProjects([
        row('main', { repo: 'Frontend_App', displayName: 'main', worktreeId: 'repo::/main' }),
        row('feature-login', {
          repo: 'Frontend_App',
          displayName: 'feature-login',
          worktreeId: 'repo::/feature'
        })
      ])
    ).toBe(false)
    expect(
      buildMobileProject(
        row('feature-login', { repo: 'Frontend_App', displayName: 'feature-login' }),
        undefined,
        true
      ).title
    ).toBe('feature-login')
    expect(
      hasCategorizedProjects(['Frontend_Auth', 'Backend_Billing'].map((name) => row(name)))
    ).toBe(true)
    expect(projectNameParts(' Frontend _ Auth _ Owner ')).toEqual({
      category: 'Frontend',
      task: 'Auth',
      role: 'Owner'
    })
    expect(projectNameParts('Frontend__Owner')).toBeNull()
    expect(projectNameParts('frontend_Auth_Owner')?.role).toBe('Owner')
  })

  it('opens the explicit owner with a pane key understood by the existing session route', () => {
    const tabs = snapshot(['Frontend_Auth_Worker', 'Frontend_Auth_Owner'])
    const project = buildMobileProject(row(), tabs, true)
    const primary = projectPrimarySession(project)
    expect(primary?.id).toBe('chat-1')
    expect(
      notificationPaneTab(
        [
          {
            type: 'agent-session',
            id: 'agent-session:chat-1',
            title: 'Frontend_Auth_Owner',
            sessionId: 'chat-1',
            agent: 'codex',
            isActive: false
          }
        ],
        primary!.paneKey
      )?.id
    ).toBe('agent-session:chat-1')
  })
  it('requires a choice between multiple category owners and never picks the most recently active one', () => {
    const project = buildMobileProject(
      row(),
      snapshot(['Frontend_Auth_Owner', 'Frontend_Billing_Owner', 'Frontend_Search_Owner']),
      true
    )
    expect(projectPrimarySession(project)).toBeUndefined()
    expect(project.sessions.filter((s) => s.owner)).toHaveLength(3)
  })
  it('does not promote a different category coordinator or a reviewer to owner', () => {
    const project = buildMobileProject(
      row(),
      snapshot(['Platform_Infra_Coordinator', 'Frontend_Review_Reviewer']),
      true
    )
    expect(projectPrimarySession(project)).toBeUndefined()
    expect(project.sessions.every((s) => !s.owner)).toBe(true)
  })
  it('keeps archived conversations separate and does not create missing sessions', () => {
    const project = buildMobileProject(row(), snapshot(['Frontend_Auth_Archived']), true)
    expect(project.sessions[0]?.archived).toBe(true)
    expect(projectPrimarySession(project)).toBeUndefined()
    expect(
      buildMobileProject(row(), { worktree: 'repo::/portfolio', tabs: [] }, true).sessions
    ).toEqual([])
  })
  it('orders categories and manual positions without moving rows on activity', () => {
    const make = (name: string, order: number, activity: number) =>
      buildMobileProject(
        row(name, { worktreeId: name, sortOrder: order, lastActivityAt: activity }),
        undefined,
        true
      )
    const projects = [
      make('Tools_Downloads', 0, 9999),
      make('Frontend_B', 2, 9998),
      make('Platform_Infra', 7, 0),
      make('Frontend_A', 1, 0)
    ]
    expect(sortMobileProjects(projects).map((p) => p.title)).toEqual([
      'A',
      'B',
      'Infra',
      'Downloads'
    ])
  })
  it('retains unclassified and folder workspaces instead of dropping or merging them', () => {
    const folder = buildMobileProject(
      row('Frontend_Design', {
        workspaceKind: 'folder-workspace',
        worktreeId: 'folder:design'
      }),
      undefined,
      true
    )
    const unknown = buildMobileProject(row('My new task', { worktreeId: 'new' }), undefined, true)
    expect(folder.category).toBe('Frontend')
    expect(folder.worktree.worktreeId).toBe('folder:design')
    expect(sortMobileProjects([unknown, folder]).map((p) => p.category)).toEqual([
      'Frontend',
      'Other'
    ])
  })
  it('reports live attention while refusing to call disconnected rows running', () => {
    const paneKey = structuredAgentSessionPaneKey(structuredAgentSessionTabId('chat-0'), 'chat-0')
    const workspace = row('Frontend_Auth', {
      agents: [{ paneKey, state: 'blocked', agentType: 'codex', updatedAt: 1 }]
    })
    const tabs = snapshot(['Frontend_Auth_Owner'])
    expect(projectMatchesFilter(buildMobileProject(workspace, tabs, true), 'attention')).toBe(true)
    expect(projectMatchesFilter(buildMobileProject(workspace, tabs, false), 'attention')).toBe(
      false
    )
    expect(buildMobileProject(workspace, tabs, false).sessions[0]?.status).toBe(
      'Checking connection'
    )
  })
  it('does not infer unfinished work from an old assistant message', () => {
    const paneKey = structuredAgentSessionPaneKey(structuredAgentSessionTabId('chat-0'), 'chat-0')
    const workspace = row('Frontend_Auth', {
      agents: [
        {
          paneKey,
          state: 'done',
          agentType: 'codex',
          updatedAt: 1,
          lastAssistantMessage: 'Usage limit reached'
        }
      ]
    })
    const project = buildMobileProject(workspace, snapshot(['Frontend_Auth_Owner']), true)
    expect(project.sessions[0]?.status).toBe('Response complete')
    expect(projectMatchesFilter(project, 'working')).toBe(false)
  })
  it('accepts new tab fields but rejects malformed inventory', () => {
    expect(
      projectSessionInventorySchema.safeParse({
        snapshots: [snapshot(['Frontend_A_Owner'])],
        authoritative: true
      }).success
    ).toBe(true)
    expect(
      projectSessionInventorySchema.safeParse({ snapshots: [{ worktree: 'a', tabs: null }] })
        .success
    ).toBe(false)
  })
  it('recognizes non-ASCII uppercase and mixed-case structured categories while keeping lowercase snake_case flat', () => {
    expect(hasCategorizedProjects([row('Équipe_Auth'), row('Équipe_Billing')])).toBe(true)
    expect(hasCategorizedProjects([row('frontend_Auth'), row('frontend_Billing')])).toBe(true)
    expect(hasCategorizedProjects([row('my_app_repo'), row('another_snake_repo')])).toBe(false)
  })
  it('preserves idle fallback agents when snapshot marks agentSessionsUnverifiable', () => {
    const workspace = row('Frontend_Auth', {
      agents: [{ paneKey: 'pane-idle', state: 'done', agentType: 'claude', updatedAt: 1 }]
    })
    const unverifiable = {
      worktree: workspace.worktreeId,
      agentSessionsUnverifiable: true as const,
      tabs: []
    }
    expect(buildMobileProject(workspace, unverifiable, true).sessions).toHaveLength(1)
    expect(
      buildMobileProject(workspace, { worktree: workspace.worktreeId, tabs: [] }, true).sessions
    ).toHaveLength(0)
  })
})
