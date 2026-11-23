import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../../shared/orca-profiles/constants'
import type { WorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type * as WriteSchedulingModule from '../profile-writing/write-scheduling'
import { MetadataLineageOperations } from './metadata-lineage-operations'

const { scheduleSaveMock } = vi.hoisted(() => ({ scheduleSaveMock: vi.fn() }))

vi.mock('../profile-writing/write-scheduling', async (importOriginal) => ({
  ...(await importOriginal<typeof WriteSchedulingModule>()),
  scheduleSave: scheduleSaveMock
}))

function link(child: WorkspaceKey, botHomeKey: WorkspaceKey) {
  return {
    childWorkspaceKey: child,
    childInstanceId: null,
    parentWorkspaceKey: botHomeKey,
    parentInstanceId: null,
    origin: 'orchestration' as const,
    capture: { source: 'orchestration-context' as const, confidence: 'explicit' as const },
    createdAt: 1
  }
}

const underAtlas = (lineage: { parentWorkspaceKey: string }) =>
  lineage.parentWorkspaceKey === 'folder:atlas-home'

describe('removeWorkspaceLineage', () => {
  it("drops only the deleted bot's links and saves once", () => {
    const state = getDefaultPersistedState('/home/test')
    state.workspaceLineageByChildKey = {
      'worktree:repo::/w/a': link('worktree:repo::/w/a', 'folder:atlas-home'),
      'folder:notes': link('folder:notes', 'folder:atlas-home'),
      'worktree:repo::/w/b': link('worktree:repo::/w/b', 'folder:shipper-home')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the removal reads only state and the mocked save scheduler.
    const operations = new MetadataLineageOperations({ state } as never, {} as never, {} as never)

    expect(operations.removeWorkspaceLineage(underAtlas)).toEqual([
      'worktree:repo::/w/a',
      'folder:notes'
    ])
    expect(Object.keys(state.workspaceLineageByChildKey)).toEqual(['worktree:repo::/w/b'])
    expect(scheduleSaveMock).toHaveBeenCalledTimes(1)

    expect(operations.removeWorkspaceLineage(underAtlas)).toEqual([])
    expect(scheduleSaveMock).toHaveBeenCalledTimes(1)
  })
})
