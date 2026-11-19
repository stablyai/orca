import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/orca-profiles/constants'
import type { WorkspaceLineage } from '../../shared/worktree/lineage-types'
import { OrcaRuntimeService } from './orca-runtime'
import { withDurableRuntimeStore } from './construction/test-context/runtime-durable-store-fixture'

const FOLDER = {
  id: 'notes',
  projectGroupId: 'group-1',
  name: 'notes',
  folderPath: '/workspace/notes',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}

function runtimeWithFolder() {
  const links: Record<string, WorkspaceLineage> = {}
  const store = withDurableRuntimeStore({
    getRepos: () => [],
    getRepo: () => undefined,
    getBots: () => [{ folderWorkspaceId: 'atlas-home' }],
    getFolderWorkspaces: () => [FOLDER],
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getAllWorkspaceLineage: () => links,
    setWorkspaceLineage: (lineage: WorkspaceLineage) => {
      links[lineage.childWorkspaceKey] = lineage
      return lineage
    },
    removeWorkspaceLineage: (matches: (lineage: WorkspaceLineage) => boolean) => {
      const released = Object.values(links).filter(matches)
      for (const lineage of released) {
        delete links[lineage.childWorkspaceKey]
      }
      return released.map((lineage) => lineage.childWorkspaceKey)
    },
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    setWorkspaceSession: () => {},
    flushOrThrow: () => {}
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies only the store reads folder resolution and the bot link make.
  return { runtime: new OrcaRuntimeService(store as never), links }
}

describe('Remove from Parent on a folder workspace saved under a bot home', () => {
  it('drops its link through the ordinary no-parent unlink, local and by RPC selector', async () => {
    for (const selector of ['folder:notes', 'id:folder:notes']) {
      const { runtime, links } = runtimeWithFolder()
      links['folder:notes'] = {
        childWorkspaceKey: 'folder:notes',
        childInstanceId: null,
        parentWorkspaceKey: 'folder:atlas-home',
        parentInstanceId: null,
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }

      // worktree.set (the paired-server route) passes every other field as undefined.
      const shown = await runtime.updateManagedWorktreeMeta(selector, {
        displayName: undefined,
        comment: undefined,
        lineage: { noParent: true }
      })

      expect(links['folder:notes']).toBeUndefined()
      expect(shown.id).toBe('folder:notes')
    }
  })
})
