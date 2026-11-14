import { inventoryProjectionKeys } from './session-search-inventory-prefetch'
import { dirname } from 'node:path'
import {
  authorityEpochBytes,
  inventoryPhysicalColumns,
  inventoryPhysicalReserve,
  inventoryValueBytes,
  inventoryMutationBytes,
  inventoryMutationFields,
  type SessionSearchAuthorityPhase
} from './session-search-inventory-footprint'
import type { SessionSearchPhysicalTable } from './session-search-inventory-page'

export type { SessionSearchAuthorityPhase } from './session-search-inventory-footprint'
export const authorityFallbackSuffixes = (phase: SessionSearchAuthorityPhase) =>
  phase === 'prepare'
    ? ['dirty', 'file-refusals']
    : phase === 'ack'
      ? ['dirty', 'file-refusals', 'refusals']
      : ['dirty', 'file-refusals', 'file-refusals:eligible', 'refusals']

export function authorityWorkingSet<T extends { path: string }>(
  inputs: readonly T[],
  offset: number,
  phase: SessionSearchAuthorityPhase,
  source: number,
  scope: string,
  root: string,
  room: { rows: number; bytes: number },
  ancestry: (path: string) => Iterable<string>
): { count: number; project: boolean; growth: Map<string, number> } {
  const keys = new Set<string>()
  const growth = new Map<string, number>()
  const prospective = inputs.slice(offset, offset + 8)
  const futureGrowth = new Map<string, number>()
  for (const input of prospective) {
    futureGrowth.set(
      input.path,
      Math.max(futureGrowth.get(input.path) ?? 0, inventoryValueBytes(input.path, input))
    )
  }
  const leaves = new Set(prospective.map((input) => input.path))
  const streamBytes = Math.max(
    0,
    ...prospective.flatMap((input) =>
      (['search_inventory_entries', 'search_inventory_activity'] as const).map((table) =>
        inventoryMutationBytes(
          table,
          source,
          input.path,
          futureGrowth.get(input.path) ?? 0,
          inventoryMutationFields(phase, table, true)
        )
      )
    )
  )
  let rows = 2 + inventoryProjectionKeys + 1 + 3,
    bytes =
      streamBytes +
      inventoryValueBytes(`source:${scope}`, { id: source, root }) +
      inventoryValueBytes(`floor:${source}`, {
        cutoff: -Number.MAX_VALUE,
        epoch: { kind: 'epochs', key: inputs[offset].path }
      })
  let count = 0
  for (const input of prospective) {
    const added: string[] = []
    const inputBytes = futureGrowth.get(input.path)!
    let nextRows = rows + 1,
      nextBytes = bytes + inventoryValueBytes(input.path, inputBytes)
    const add = (key: string, size: number, copies = 1): boolean => {
      if (keys.has(key)) {
        return true
      }
      nextRows += copies
      nextBytes += size + JSON.stringify(key).length * 4
      if (nextRows > room.rows || nextBytes > room.bytes) {
        return false
      }
      keys.add(key)
      added.push(key)
      return true
    }
    const physical = (table: SessionSearchPhysicalTable, path: string) => {
      const key = `${table}:${source}:${path}`
      if (keys.has(key)) {
        return true
      }
      const row = Object.fromEntries(
        inventoryPhysicalColumns(table)
          .split(',')
          .map((name) => [name, -Number.MAX_VALUE])
      )
      Object.assign(row, { path, parent: dirname(path) })
      const names = inventoryMutationFields(phase, table, leaves.has(path))
      return add(
        key,
        inventoryValueBytes(`fact:${key}`, row) +
          inventoryPhysicalReserve(table, source, path, futureGrowth.get(path) ?? 0, names, row) +
          inventoryValueBytes('query-row', row),
        names.length ? 5 : 1
      )
    }
    let fits = true
    if (phase !== 'ack') {
      if (phase === 'apply') {
        for (const path of ancestry(input.path)) {
          if (!physical('search_inventory_entries', path)) {
            fits = false
            break
          }
        }
      } else {
        fits = physical('search_inventory_entries', input.path)
      }
    }
    if (fits) {
      for (const path of phase === 'ack' ? [input.path] : ancestry(input.path)) {
        if (!physical('search_inventory_activity', path)) {
          fits = false
          break
        }
      }
    }
    if (fits) {
      for (const suffix of authorityFallbackSuffixes(phase)) {
        const key = `fallback:${scope}:${suffix}:${input.path}`
        if (
          !add(
            key,
            inventoryValueBytes(key, undefined) +
              inventoryValueBytes('query-row', {
                requested_path: input.path,
                key: null,
                value: null,
                parent: null,
                group_key: null,
                rank: null,
                ready: null,
                tie: null
              })
          )
        ) {
          fits = false
          break
        }
      }
    }
    if (fits && (phase === 'prepare' || phase === 'apply')) {
      fits = add(`epoch:${offset + count}`, authorityEpochBytes(source, input.path), 3)
    }
    if (!fits) {
      for (const key of added) {
        keys.delete(key)
      }
      if (!count) {
        return { count: 1, project: false, growth: new Map([[input.path, inputBytes]]) }
      }
      break
    }
    rows = nextRows
    bytes = nextBytes
    growth.set(input.path, Math.max(growth.get(input.path) ?? 0, inputBytes))
    count++
  }
  return { count, project: true, growth }
}
