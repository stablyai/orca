import { dirname } from 'node:path'
import { sessionSearchInventoryColumns } from './session-search-inventory-relation'
import type { SessionSearchPhysicalTable } from './session-search-inventory-page'

const members = {
  search_inventory_entries: ['files', 'directories'],
  search_inventory_activity: ['authority', 'observing', 'delivery']
} as const
export const inventoryPageRows = 256
export const inventoryPageBytes = 256 * 1024
export const inventoryValueBytes = (key: string, value: unknown) =>
  JSON.stringify([key, value]).length * 2 + 64

function physicalColumns(table: SessionSearchPhysicalTable): string {
  return [
    ...new Set([
      'parent',
      ...members[table].flatMap((member) => sessionSearchInventoryColumns(member).split(',')),
      ...(table === 'search_inventory_activity' ? ['reclaimable'] : [])
    ])
  ].join(',')
}

const columns = {
  search_inventory_entries: physicalColumns('search_inventory_entries'),
  search_inventory_activity: physicalColumns('search_inventory_activity')
}
export const inventoryPhysicalColumns = (table: SessionSearchPhysicalTable) => columns[table]
export type SessionSearchAuthorityPhase = 'prepare' | 'apply' | 'ack' | 'forget'
export function inventoryMutationFields(
  phase: SessionSearchAuthorityPhase | undefined,
  table: SessionSearchPhysicalTable,
  leaf: boolean
): string[] {
  const names = inventoryPhysicalColumns(table)
    .split(',')
    .filter((name) => name !== 'path' && name !== 'parent')
  if (!phase) {
    return names
  }
  if (table === 'search_inventory_entries') {
    if (phase === 'prepare' || phase === 'ack') {
      return []
    }
    return leaf
      ? names.filter((name) => name !== 'directory')
      : phase === 'apply'
        ? ['directory']
        : []
  }
  if (!leaf && (phase === 'apply' || phase === 'ack')) {
    return []
  }
  if (!leaf) {
    return ['authority_self', 'authority_tree', 'reclaimable']
  }
  return names.filter(
    (name) =>
      (!name.startsWith('delivery_') || phase !== 'prepare') &&
      (!name.startsWith('observation_') || phase !== 'ack')
  )
}
export function inventoryMutationBytes(
  table: SessionSearchPhysicalTable,
  source: number,
  path: string,
  growthBytes: number,
  names: string[],
  row: Record<string, unknown> = {}
): number {
  if (!names.length) {
    return 0
  }
  const fields = Object.fromEntries(
    names.map((name) => [name, typeof row[name] === 'string' ? row[name] : -Number.MAX_VALUE])
  )
  return (
    (inventoryValueBytes(`write:${table}:${source}:${path}`, {
      table,
      source,
      path,
      parent: dirname(path),
      fields
    }) +
      growthBytes * 2) *
    3
  )
}
export function inventoryPhysicalReserve(
  table: SessionSearchPhysicalTable,
  source: number,
  path: string,
  growthBytes: number,
  names: string[],
  row: Record<string, unknown> = {}
): number {
  const mutation = inventoryMutationBytes(table, source, path, growthBytes, names, row)
  return mutation
    ? mutation + inventoryValueBytes(`fact:${table}:${source}:${path}`, row) + growthBytes * 2
    : 0
}
export function authorityEpochBytes(source: number, path: string): number {
  return (
    inventoryValueBytes(`epoch:${source}:${-Number.MAX_VALUE}`, {
      source,
      revision: -Number.MAX_VALUE,
      path,
      cutoff: -Number.MAX_VALUE
    }) * 3
  )
}
