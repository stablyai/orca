import type { SessionSearchCatalogRow } from './session-search-catalog-types'
import type { SessionSearchValueRow } from './session-search-value-row'
import { sessionSearchFileFacts } from './session-search-file-facts'

export const SESSION_SEARCH_INVENTORY_MEMBERS = [
  'files',
  'directories',
  'directory-input',
  'authority',
  'observing',
  'observation-epochs',
  'delivery',
  'epochs',
  'removal-epochs'
] as const
export type SessionSearchInventoryMember = (typeof SESSION_SEARCH_INVENTORY_MEMBERS)[number]

export type SessionSearchInventoryRelation = {
  table: string
  present: string
  key: string
  parent: string
  group: string
  rank: string
  ready: string
  tie: string
}

export function sessionSearchInventoryRelation(
  member: SessionSearchInventoryMember
): SessionSearchInventoryRelation {
  const base = { key: 'path', parent: 'parent', group: "''", rank: '0', ready: '0', tie: '0' }
  if (member === 'files' || member === 'directories') {
    return {
      ...base,
      table: 'search_inventory_entries',
      present: member === 'files' ? 'file_revision IS NOT NULL' : 'directory=1',
      group: member === 'files' ? "COALESCE(dependency,'')" : "''"
    }
  }
  if (member === 'directory-input') {
    return { ...base, table: 'search_inventory_staging', present: '1', group: 'epoch' }
  }
  if (member === 'epochs' || member === 'removal-epochs' || member === 'observation-epochs') {
    return {
      ...base,
      table: 'search_inventory_epochs',
      present: `kind='${member}'${member === 'observation-epochs' ? '' : " AND kind<>'observation-epochs'"}`,
      key: member === 'observation-epochs' ? 'CAST(revision AS TEXT)' : 'path',
      parent: "''",
      rank: 'cutoff'
    }
  }
  const active = { ...base, table: 'search_inventory_activity' }
  if (member === 'authority') {
    return {
      ...active,
      present: 'authority_self IS NOT NULL',
      parent: "''",
      rank: 'authority_tree',
      ready: 'reclaimable'
    }
  }
  return {
    ...active,
    present:
      member === 'observing' ? 'observation_authority IS NOT NULL' : 'delivery_revision IS NOT NULL'
  }
}

export function sessionSearchInventoryColumns(member: SessionSearchInventoryMember): string {
  const facts = 'mtime,size,dev,ino,nlink,alias_mtime,sidecar'
  const columns: Record<SessionSearchInventoryMember, string> = {
    files: `file_revision,dependency,${facts}`,
    directories: 'directory',
    'directory-input': 'file,directory',
    authority: 'authority_self,authority_tree',
    observing: 'observation_file,observation_dirty,observation_authority',
    delivery: `delivery_revision,delivery_removed,delivery_force,delivery_metadata,delivery_authority,${facts
      .split(',')
      .map((name) => `delivery_${name}`)
      .join(',')}`,
    epochs: 'revision,cutoff,sealed',
    'removal-epochs': 'revision,cutoff',
    'observation-epochs': 'revision,cutoff'
  }
  return `path,${columns[member]}`
}

export function decodeSessionSearchInventoryValue(
  member: SessionSearchInventoryMember,
  row: Record<string, unknown>
): SessionSearchValueRow {
  const path = String(row.path)
  let value: unknown
  switch (member) {
    case 'files':
      value = {
        revision: Number(row.file_revision),
        file: sessionSearchFileFacts(row, path),
        ...(row.dependency == null ? {} : { dependency: String(row.dependency) })
      }
      break
    case 'directories':
    case 'removal-epochs':
      value = true
      break
    case 'directory-input':
      value = {
        ...(row.file == null ? {} : { file: row.file === 1 }),
        ...(row.directory == null ? {} : { directory: row.directory === 1 })
      }
      break
    case 'authority':
      value = { self: Number(row.authority_self), tree: Number(row.authority_tree) }
      break
    case 'observing':
      value = JSON.stringify([
        Number(row.observation_file),
        Number(row.observation_dirty),
        Number(row.observation_authority)
      ])
      break
    case 'observation-epochs':
      value = path
      break
    case 'epochs':
      value = {
        revision: Number(row.revision),
        cutoff: Number(row.cutoff),
        sealed: row.sealed === 1
      }
      break
    case 'delivery':
      value = {
        ...(row.delivery_mtime == null
          ? {}
          : { file: sessionSearchFileFacts(row, path, 'delivery_') }),
        ...(row.delivery_removed == null ? {} : { removed: row.delivery_removed === 1 }),
        force: row.delivery_force === 1,
        ...(row.delivery_metadata == null ? {} : { metadata: row.delivery_metadata === 1 }),
        revision: Number(row.delivery_revision),
        ...(row.delivery_authority == null ? {} : { authority: Number(row.delivery_authority) })
      }
      break
  }
  return {
    key: String(row.projected_key),
    data: value,
    parent: String(row.projected_parent),
    group: String(row.projected_group),
    rank: Number(row.projected_rank),
    ready: Number(row.projected_ready),
    tie: 0
  }
}

export function decodeSessionSearchInventoryRow(
  member: SessionSearchInventoryMember,
  row: Record<string, unknown>
): SessionSearchCatalogRow {
  const { data, ...fields } = decodeSessionSearchInventoryValue(member, row)
  return { ...fields, value: JSON.stringify(data) }
}
