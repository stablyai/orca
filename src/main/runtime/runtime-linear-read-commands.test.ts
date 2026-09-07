import { describe, expect, it, vi } from 'vitest'
import type * as RuntimeLinearCommandDependencies from './runtime-linear-command-dependencies'

const mocks = vi.hoisted(() => ({ listLinearIssues: vi.fn() }))

vi.mock('./runtime-linear-command-dependencies', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeLinearCommandDependencies>()),
  listLinearIssues: mocks.listLinearIssues
}))

import { RuntimeLinearReadCommands } from './runtime-linear-read-commands'

function createCommands(): RuntimeLinearReadCommands {
  return new RuntimeLinearReadCommands({
    runtimeAvailable: () => true,
    showTerminal: async () => {
      throw new Error('unused')
    },
    resolveWorktreeSelector: async () => {
      throw new Error('unused')
    },
    listResolvedWorktrees: async () => [],
    setWorktreeMeta: () => {},
    emitClientEvent: () => {}
  })
}

describe('RuntimeLinearReadCommands', () => {
  it('reports truncated project results at the top level', async () => {
    const commands = createCommands()
    vi.spyOn(commands, 'linearListProjects').mockResolvedValue({
      items: [
        { id: 'project-1', name: 'One' },
        { id: 'project-2', name: 'Two' }
      ],
      hasMore: false,
      errors: []
    } as never)

    await expect(commands.linearProjectListForAgents({ limit: 1 })).resolves.toMatchObject({
      projects: [{ id: 'project-1', name: 'One' }],
      truncated: true,
      meta: { hasMore: true, returned: 1 }
    })
  })

  it('reports issue truncation and priority labels at the top level', async () => {
    mocks.listLinearIssues.mockResolvedValue({
      items: [
        {
          id: 'issue-1',
          identifier: 'ORCA-1',
          title: 'Preserve result fields',
          url: 'https://linear.app/orca/issue/ORCA-1',
          state: null,
          team: null,
          project: null,
          assignee: null,
          priority: 2,
          estimate: null,
          dueDate: null,
          updatedAt: '2026-08-29T00:00:00.000Z',
          workspaceId: 'workspace-1',
          workspaceName: 'Orca'
        }
      ],
      hasMore: true,
      errors: []
    })

    await expect(createCommands().linearIssueListForAgents({ limit: 1 })).resolves.toMatchObject({
      issues: [{ identifier: 'ORCA-1', priority: 2, priorityLabel: 'high' }],
      truncated: true,
      meta: { hasMore: true, returned: 1 }
    })
  })
})
