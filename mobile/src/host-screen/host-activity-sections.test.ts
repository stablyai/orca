import { describe, expect, it } from 'vitest'
import { buildHostActivitySections } from './host-activity-sections'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-worktree-contracts'
import type { Worktree } from '../worktree/workspace-list-types'

const now = 1_800_000_000_000
const agent = (
  paneKey: string,
  state: RuntimeWorktreeAgentRow['state'],
  extra = {}
): RuntimeWorktreeAgentRow => ({
  paneKey,
  state,
  parentPaneKey: null,
  agentType: 'codex',
  prompt: 'Investigate',
  taskTitle: null,
  displayName: null,
  conversationName: paneKey,
  lastAssistantMessage: 'Latest response',
  toolName: null,
  toolInput: null,
  interrupted: false,
  stateStartedAt: now - 1000,
  updatedAt: now,
  ...extra
})
const workspace = (agents: RuntimeWorktreeAgentRow[], extra = {}): Worktree => ({
  worktreeId: 'solar::main',
  repoId: 'solar',
  repo: 'SolarSupportAI',
  branch: 'main',
  displayName: 'main',
  path: '/solar',
  liveTerminalCount: agents.length,
  hasAttachedPty: true,
  unread: false,
  isPinned: false,
  linkedPR: null,
  agents,
  ...extra
})

describe('host Activity View', () => {
  it('lists five working and six done sessions individually in a shared main workspace', () => {
    const worktrees = [
      workspace([
        ...Array.from({ length: 5 }, (_, i) => agent(`working-${i}`, 'working')),
        ...Array.from({ length: 6 }, (_, i) => agent(`done-${i}`, 'done'))
      ])
    ]
    const sections = buildHostActivitySections(worktrees, '', now)
    expect(sections.map((s) => [s.key, s.data.length])).toEqual([
      ['working', 5],
      ['done', 6]
    ])
    expect(new Set(sections.flatMap((s) => s.data.map((r) => r.key))).size).toBe(11)
  })

  it('orders attention, working, monitoring and done, preserving recent completion ordering', () => {
    const rows = [
      workspace([
        agent('old', 'done', { stateStartedAt: now - 5000 }),
        agent('monitor', 'working', { workingMode: 'monitoring' }),
        agent('worker', 'working'),
        agent('ask', 'waiting'),
        agent('permission', 'blocked'),
        agent('new', 'done')
      ])
    ]
    const sections = buildHostActivitySections(rows, '', now)
    expect(sections.map((s) => s.key)).toEqual(['waiting', 'working', 'monitoring', 'done'])
    expect(sections[0].data.map((r) => r.agent.paneKey)).toEqual(['ask', 'permission'])
    expect(sections[3].data.map((r) => r.agent.paneKey)).toEqual(['new', 'old'])
  })

  it('searches conversation titles, projects, branches and latest messages without collapsing sessions', () => {
    const rows = [
      workspace([
        agent('review', 'done', { conversationName: 'Review PR 2135' }),
        agent('fix', 'working')
      ])
    ]
    expect(buildHostActivitySections(rows, '2135', now)[0].data[0].agent.paneKey).toBe('review')
    expect(buildHostActivitySections(rows, 'solar', now).flatMap((s) => s.data)).toHaveLength(2)
    expect(
      buildHostActivitySections(rows, 'LATEST RESPONSE', now).flatMap((s) => s.data)
    ).toHaveLength(2)
    expect(buildHostActivitySections(rows, 'nonexistent', now)).toEqual([])
  })

  it('keeps identical pane keys on different execution hosts distinct and retains navigation targets', () => {
    const local = workspace([agent('pane-1', 'working')])
    const remote = workspace([agent('pane-1', 'done')], { hostId: 'runtime:remote' })
    const rows = buildHostActivitySections([local, remote], '', now).flatMap((s) => s.data)
    expect(rows[0].key).not.toBe(rows[1].key)
    expect(rows[1].worktree).toBe(remote)
    expect(rows[1].agent.paneKey).toBe('pane-1')
  })

  it('does not claim stale active sessions are still working and includes idle sessions', () => {
    const sections = buildHostActivitySections(
      [
        workspace([
          agent('stale', 'working', { updatedAt: now - 10 * 86400_000, hasLivePty: true }),
          agent('idle', 'working', { updatedAt: now - 10 * 86400_000 })
        ])
      ],
      '',
      now
    )
    expect(sections.map((s) => s.key)).toEqual(['other'])
    expect(sections[0].data).toHaveLength(2)
  })
})
