import { expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { buildProjectConversations } from './project-conversations'
import {
  conversationAgent,
  conversationHistory,
  conversationWorkspace
} from './project-conversations.test-fixture'

const hosts = ['local', 'runtime:one', 'ssh:one'] as const
it.each<{ visibleHostIds: ExecutionHostId[] | null; expected: readonly ExecutionHostId[] }>([
  { visibleHostIds: null, expected: hosts },
  { visibleHostIds: [], expected: [] },
  { visibleHostIds: ['local'], expected: ['local'] },
  { visibleHostIds: ['runtime:one'], expected: ['runtime:one'] }
])(
  'never recreates hidden-host projects from workspaces or unmatched history: $visibleHostIds',
  ({ visibleHostIds, expected }) => {
    const projects = buildProjectConversations({
      workspaces: hosts.map((hostId) =>
        conversationWorkspace({
          hostId,
          workspaceKind: hostId === 'runtime:one' ? 'folder-workspace' : undefined,
          agents: [conversationAgent({ paneKey: `chat:${hostId}` })]
        })
      ),
      history: hosts.map((executionHostId) =>
        conversationHistory({
          executionHostId,
          id: `history:${executionHostId}`,
          cwd: '/unmatched/old-project'
        })
      ),
      repos: [],
      tabs: new Map(),
      now: 1000,
      untitled: 'New conversation',
      visibleHostIds
    })
    expect([...new Set(projects.map((project) => project.hostId))].sort()).toEqual(
      [...expected].sort()
    )
    expect(projects).toHaveLength(expected.length * 2)
  }
)

it('uses phone-owned host context for legacy rows without trusting same-named wire fields', () => {
  const workspace = {
    ...conversationWorkspace({
      hostId: undefined,
      agents: [conversationAgent({ paneKey: 'chat:remote' })]
    }),
    hostContextHostId: 'local',
    hostContextHealthLabel: 'healthy'
  }
  const context = {
    hostContextHostId: 'ssh:one',
    hostContextLabel: 'Remote development',
    hostContextHealthLabel: 'Disconnected'
  } as const
  const [project] = buildProjectConversations({
    workspaces: [workspace],
    hostContextOf: () => context,
    visibleHostIds: ['ssh:one'],
    history: [],
    repos: [],
    tabs: new Map(),
    now: 1000,
    untitled: 'New conversation'
  })
  expect(project?.hostId).toBe('ssh:one')
  expect(project?.hostLabel).toBe('Remote development')
  expect(project?.data[0]?.workspace).toBe(workspace)
  expect(project?.data[0]?.workspaceContext).toBe(context)
})
