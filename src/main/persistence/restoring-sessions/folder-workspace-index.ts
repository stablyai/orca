import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'

const indexes = new WeakMap<
  readonly FolderWorkspace[],
  { length: number; byId: Map<string, FolderWorkspace> }
>()

/** One folder workspace by id without scanning them all. Create, removal and hydration replace
 *  the array, so an index of its records stays exact; a rename edits the record it returns; an
 *  in-place append (catalog migration) changes the length and rebuilds. */
export function findFolderWorkspace(
  list: readonly FolderWorkspace[],
  id: string
): FolderWorkspace | undefined {
  let index = indexes.get(list)
  if (index?.length !== list.length) {
    index = {
      length: list.length,
      byId: new Map(list.map((workspace) => [workspace.id, workspace]))
    }
    indexes.set(list, index)
  }
  return index.byId.get(id)
}
