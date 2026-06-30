import type { ScryModel } from './model'
import type { ScryerIdKind, ScryerIdMinter } from './types'

export type ScryerIdUniverse = {
  committed?: ScryModel
  planned?: ScryModel
  reserved?: Iterable<string>
}

function numericSuffix(id: string, prefix: string): number | null {
  if (!id.startsWith(prefix)) {
    return null
  }
  const suffix = Number(id.slice(prefix.length))
  return Number.isInteger(suffix) && suffix >= 0 ? suffix : null
}

function scanIds(model: ScryModel | undefined, ids: Set<string>): void {
  if (!model) {
    return
  }
  for (const node of model.nodes) {
    ids.add(node.id)
    for (const responsibility of node.responsibilities ?? []) {
      ids.add(responsibility.id)
    }
  }
  for (const group of model.groups) {
    ids.add(group.id)
    for (const responsibility of group.responsibilities ?? []) {
      ids.add(responsibility.id)
    }
  }
  for (const link of model.links) {
    ids.add(link.id)
  }
}

function nextNumber(ids: Set<string>, prefix: string): number {
  let max = 0
  for (const id of ids) {
    const suffix = numericSuffix(id, prefix)
    if (suffix !== null && suffix > max) {
      max = suffix
    }
  }
  return max + 1
}

export function createScryerIdMinter(universe: ScryerIdUniverse): ScryerIdMinter {
  const ids = new Set<string>()
  scanIds(universe.committed, ids)
  scanIds(universe.planned, ids)
  for (const id of universe.reserved ?? []) {
    ids.add(id)
  }

  function reserve(id: string): string {
    if (ids.has(id)) {
      throw new Error(`Scryer id '${id}' is already reserved`)
    }
    ids.add(id)
    return id
  }

  return {
    node() {
      return reserve(`node-${nextNumber(ids, 'node-')}`)
    },
    responsibility() {
      return reserve(`resp-${nextNumber(ids, 'resp-')}`)
    },
    group() {
      return reserve(`group-${nextNumber(ids, 'group-')}`)
    },
    link(src, dst) {
      return reserve(`link-${src}-${dst}`)
    },
    reserveExisting(id: string, _kind?: ScryerIdKind) {
      reserve(id)
    }
  }
}
