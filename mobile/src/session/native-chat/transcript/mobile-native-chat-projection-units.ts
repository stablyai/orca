import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import {
  foldToolMessages,
  type NativeChatToolFoldKind
} from '../../../../../src/shared/native-chat/tools/native-chat-tool-fold'
import {
  orphanRowId,
  type NativeChatOrphanOrigin
} from '../../../../../src/shared/native-chat/tools/native-chat-folded-tool-results'
import { finishMobileNativeChatMessages } from '../mobile-native-chat-render-data'

export type Unit = {
  sources: readonly NativeChatMessage[]
  rows: NativeChatMessage[]
  orphans: readonly NativeChatOrphanOrigin[]
}

export function groupMobileNativeChatUnitMembers(
  grouped: readonly NativeChatMessage[],
  kinds: ReadonlyMap<NativeChatMessage, NativeChatToolFoldKind>
): NativeChatMessage[][] {
  const members: NativeChatMessage[][] = []
  let active = false
  for (const source of grouped) {
    const kind = kinds.get(source)!
    if (active && (kind === 'tool' || kind === 'sidecar' || kind === 'pass')) {
      members.at(-1)!.push(source)
    } else {
      members.push([source])
      active = source.role === 'assistant' && kind !== 'orphan'
    }
  }
  return members
}

export function buildMobileNativeChatUnit(
  sources: readonly NativeChatMessage[],
  ids: ReadonlySet<string>,
  kinds: ReadonlyMap<NativeChatMessage, NativeChatToolFoldKind>,
  before: Unit | undefined
): Unit {
  if (
    before &&
    before.sources.length === sources.length &&
    before.sources.every((source, index) => source === sources[index])
  ) {
    return before
  }
  const substituted = before && substituteProse(before, sources, kinds)
  const orphans: NativeChatOrphanOrigin[] = []
  const rows =
    substituted ??
    finishMobileNativeChatMessages(
      foldToolMessages(sources, ids, kinds, (origin) => orphans.push(origin))
    )
  return { sources, rows, orphans: substituted ? before!.orphans : orphans }
}

export function buildMobileNativeChatUnits(
  grouped: readonly NativeChatMessage[],
  kinds: ReadonlyMap<NativeChatMessage, NativeChatToolFoldKind>,
  previous?: { units: readonly Unit[] }
): Unit[] {
  const ids = new Set(grouped.map((row) => row.id))
  const oldUnits = new Map(previous?.units.map((unit) => [unit.sources[0]!.id, unit]))
  const units = groupMobileNativeChatUnitMembers(grouped, kinds).map((sources) =>
    buildMobileNativeChatUnit(sources, ids, kinds, oldUnits.get(sources[0]!.id))
  )
  const allocated = new Set(ids)
  const occurrences = new Map<string, number>()
  return units.map((unit) => {
    const renamed = new Map<NativeChatMessage, NativeChatMessage>()
    const orphans = unit.orphans.map((origin) => {
      const id = orphanRowId(origin.sourceId, allocated, occurrences)
      allocated.add(id)
      if (id === origin.row.id) {
        return origin
      }
      const row = { ...origin.row, id }
      renamed.set(origin.row, row)
      return { ...origin, row }
    })
    return renamed.size === 0
      ? unit
      : {
          ...unit,
          orphans,
          rows: unit.rows.map((row) => renamed.get(row) ?? row)
        }
  })
}

function substituteProse(
  before: Unit,
  sources: readonly NativeChatMessage[],
  kinds: ReadonlyMap<NativeChatMessage, NativeChatToolFoldKind>
): NativeChatMessage[] | null {
  if (before.sources.length !== sources.length) {
    return null
  }
  const changed = sources.flatMap((source, index) =>
    source === before.sources[index] ? [] : [index]
  )
  if (changed.length !== 1 || changed[0] !== 0) {
    return null
  }
  const old = before.sources[0]!,
    next = sources[0]!
  if (
    old.role !== next.role ||
    (next.role !== 'assistant' && next.role !== 'reasoning') ||
    old.unpairedToolResults ||
    next.unpairedToolResults ||
    !old.blocks.every((block) => block.type === 'text' && !block.providerFrame) ||
    !next.blocks.every((block) => block.type === 'text' && !block.providerFrame)
  ) {
    return null
  }
  const target = before.rows.find((row) => row.id === old.id && row.role === old.role)
  if (!target || !old.blocks.every((block, index) => block === target.blocks[index])) {
    return null
  }
  const contribution = sources
    .slice(1)
    .findLast(
      (source) =>
        source.journalPosition && (kinds.get(source) === 'tool' || kinds.get(source) === 'sidecar')
    )
  const replacement: NativeChatMessage = {
    ...next,
    blocks: [...next.blocks, ...target.blocks.slice(old.blocks.length)],
    ...(contribution ? { foldedJournalPosition: contribution.journalPosition } : {})
  }
  return before.rows.map((row) => (row === target ? replacement : row))
}
