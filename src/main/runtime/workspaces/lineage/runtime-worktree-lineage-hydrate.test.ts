import { describe, expect, it, vi } from 'vitest'
import { RuntimeWorktreeLineageController } from './runtime-worktree-lineage-controller'
import type { ResolvedWorktree } from '../catalog/runtime-worktree-path-identity'
import type { WorkspaceLineage } from '../../../../shared/worktree/lineage-types'

const CHILD = 'repo-a::/workspace/child'
const PARENT = 'repo-a::/workspace/parent'

function resolved(id: string, comment = ''): ResolvedWorktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hydrate reads only these fields before the skip under test.
  return { id, instanceId: `${id}-instance`, hostId: 'local', path: id, comment } as never
}

describe('lineage hydrate', () => {
  it('keeps a parent set while the task lookup was pending', async () => {
    const workspaceRows: Record<string, WorkspaceLineage> = {}
    const setWorktreeLineage = vi.fn()
    const store = {
      getWorktreeLineage: () => undefined,
      getWorkspaceLineage: (key: string) => workspaceRows[key],
      getAllWorktreeLineage: () => ({}),
      setWorktreeLineage
    }
    const controller = new RuntimeWorktreeLineageController({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a store double with the lineage reads and the write hydrate uses.
      getStore: () => store as never,
      getDb: () =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the two orchestration reads behind a task lookup.
        ({
          getDispatchContext: () => ({ assignee_handle: 'term_parent' }),
          getTask: () => undefined
        }) as never,
      resolveWorktree: async () => resolved(PARENT),
      listResolvedWorktrees: async () => [resolved(CHILD, 'task_abc123')],
      // The user attaches the child to a folder while hydrate awaits the task's terminal.
      showTerminal: async () => {
        workspaceRows[`worktree:${CHILD}`] = {
          childWorkspaceKey: `worktree:${CHILD}`,
          childInstanceId: `${CHILD}-instance`,
          parentWorkspaceKey: 'folder:feature',
          parentInstanceId: null,
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 1
        }
        return { worktreeId: PARENT }
      }
    })

    await controller.listWorktreeLineage()

    expect(setWorktreeLineage).not.toHaveBeenCalled()
    expect(workspaceRows[`worktree:${CHILD}`]?.parentWorkspaceKey).toBe('folder:feature')
  })
})
