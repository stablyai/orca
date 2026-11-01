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
