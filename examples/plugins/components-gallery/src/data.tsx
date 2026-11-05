import {
  atom,
  read,
  set,
  Stack,
  Table,
  Text,
  Tree,
  update,
  type TableSort,
  type TreeItem
} from 'orca'
import { folderChildren, PAGE_SIZE, sortedFiles } from './files'

export const sort = atom<TableSort>({ column: 'name', direction: 'asc' })
export const loaded = atom(PAGE_SIZE)
export const selected = atom<string[]>([])
export const opened = atom<string | null>(null)
/** Lazily loaded folder children, by folder key. */
export const folders = atom<Record<string, TreeItem[]>>({})
export const selectedItem = atom('')
/** Open folders, kept here so they stay open when the Data tab is shown again. */
export const expanded = atom<string[]>([])

const ROOTS = ['src', 'tests', 'docs']

export function DataTab() {
  const files = sortedFiles(read(sort))
  const rows = files.slice(0, read(loaded)).map((file) => ({
    key: file.path,
    cells: { name: file.name, kind: file.kind, size: file.size }
  }))
  const items: TreeItem[] = ROOTS.map((key) => ({
    key,
    label: key,
    icon: 'folder',
    hasChildren: true,
    children: read(folders)[key]
  }))
  return (
    <Stack gap="md">
      <Table
        label="Files"
        columns={[
          { key: 'name', label: 'Name', sortable: true, minWidth: 'sm' },
          // Secondary: drops out when the sidebar is narrow.
          { key: 'kind', label: 'Kind', width: 'sm', hideBelow: 'sm' },
          { key: 'size', label: 'Bytes', width: 'sm', align: 'end', sortable: true }
        ]}
        rows={rows}
        sort={read(sort)}
        selectionMode="multiple"
        selected={read(selected)}
        hasMore={read(loaded) < files.length}
        maxHeight="md"
        onSortChange={(next) => {
          set(sort, next)
          set(loaded, PAGE_SIZE)
        }}
        onSelectionChange={({ keys }) => set(selected, keys)}
        onRowAction={({ key }) => set(opened, key)}
        onLoadMore={() => update(loaded, (count) => count + PAGE_SIZE)}
      />
      <Text muted size="xs">
        {read(selected).length} selected
        {read(opened) ? `, opened ${read(opened)}` : ''}
      </Text>
      <Tree
        label="Folders"
        items={items}
        selected={read(selectedItem)}
        expanded={read(expanded)}
        onSelect={({ key }) => set(selectedItem, key)}
        onToggle={({ key, expanded: open }) => {
          update(expanded, (keys) => (open ? [...keys, key] : keys.filter((k) => k !== key)))
          // Children load on first expand, the way a file system or API would be read.
          if (open && !read(folders)[key]) {
            update(folders, (all) => ({ ...all, [key]: folderChildren(key) }))
          }
        }}
      />
    </Stack>
  )
}
