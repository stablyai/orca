import { expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { FolderWorkspacePersistenceOperations } from './folder-workspace-operations'

function folder(id: string, name: string): FolderWorkspace {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: lookups and renames read only `id` and `name`.
  return { id, name } as unknown as FolderWorkspace
}

/** Folder records whose array counts every element read. */
function counted(count: number) {
  const reads = { count: 0 }
  const records = Array.from({ length: count }, (_, index) =>
    folder(`folder-${index}`, `Folder ${index}`)
  )
  const list = new Proxy(records, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        reads.count++
      }
      // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap forwards the raw key with its receiver.
      return Reflect.get(target, key, receiver)
    }
  })
  return { list, reads }
}

it.each([750, 7_500])(
  'finds one folder workspace by id among %i without scanning them on each lookup',
  (folders) => {
    const { list, reads } = counted(folders)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: folder lookups read only `folderWorkspaces`.
    const state = { folderWorkspaces: list } as unknown as PersistedState
    const operations = new FolderWorkspacePersistenceOperations({
      state,
      scheduleSave: vi.fn(),
      removeWorkspaceLineageForRemovedFolder: vi.fn(),
      pruneMobileClientTabSelections: vi.fn(),
      hydrateRepo: (repo) => repo
    })
    const last = `folder-${folders - 1}`
    expect(operations.getFolderWorkspace(last)?.name).toBe(`Folder ${folders - 1}`)
    reads.count = 0

    for (let lookup = 0; lookup < 10; lookup++) {
      operations.getFolderWorkspace(last)
    }
    operations.updateFolderWorkspace(last, { name: 'Docs' })
    expect(operations.getFolderWorkspace(last)?.name).toBe('Docs')
    expect(reads.count).toBe(0)

    // Creation and migration both change the collection; their records are found.
    state.folderWorkspaces = [folder('created', 'Created'), ...(state.folderWorkspaces ?? [])]
    state.folderWorkspaces.push(folder('migrated', 'Migrated'))
    expect(operations.getFolderWorkspace('created')?.name).toBe('Created')
    expect(operations.getFolderWorkspace('migrated')?.name).toBe('Migrated')
  }
)
