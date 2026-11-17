import {
  noteStreamedTextRevision,
  streamedTextReplacementIndexes
} from '../../../../../../src/shared/agent-session/view/structured-agent-session-streamed-text-rows'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { buildNativeChatFoldUnit } from '../../../../../../src/shared/native-chat/transcript/folding/native-chat-fold-units'
import type { MobileNativeChatProjection } from './mobile-native-chat-projection'
import { finishMobileNativeChatMessages } from './mobile-native-chat-render-data'

type Places = Map<string, { unit: number; start: number }>
const places = new WeakMap<MobileNativeChatProjection, Places>()
const bases = new WeakMap<MobileNativeChatProjection, MobileNativeChatProjection>()

/** Plain text revisions replace their existing fold unit; structural preparation stays cached. */
export function projectMobileNativeChatText(
  input: readonly NativeChatMessage[],
  previous: MobileNativeChatProjection
): MobileNativeChatProjection | null {
  const base = bases.get(previous) ?? previous
  const indexes = streamedTextReplacementIndexes(base.input, input)
  if (indexes === null) {
    return null
  }
  let at = places.get(base)
  if (!at) {
    at = new Map()
    let start = 0
    base.units.forEach((unit, index) => {
      unit.sources.forEach((row) => at!.set(row.id, { unit: index, start }))
      start += unit.rows.length
    })
    places.set(base, at)
  }
  const revised = new Map<number, Map<NativeChatMessage, NativeChatMessage>>()
  for (const index of indexes) {
    const raw = base.input[index]!
    const source = base.sources.get(raw.id)
    if (!source?.harness) {
      continue
    }
    const next = input[index]!
    const place = at.get(raw.id)
    if (
      !place ||
      source.skill !== raw ||
      source.harness !== raw ||
      !raw.blocks.every((block) => block.type === 'text' && !block.providerFrame) ||
      !next.blocks.every((block) => block.type === 'text' && !block.providerFrame)
    ) {
      return null
    }
    const swaps = revised.get(place.unit) ?? new Map()
    swaps.set(raw, next)
    revised.set(place.unit, swaps)
  }
  const rows = base.rows.slice()
  const changed: number[] = []
  for (const [index, swaps] of revised) {
    const unit = base.units[index]!
    const kinds = new Map(unit.sources.map((row) => [row, base.kinds.get(row)!]))
    for (const [before, next] of swaps) {
      kinds.set(next, kinds.get(before)!)
    }
    const rebuilt = buildNativeChatFoldUnit(
      unit.sources.map((row) => swaps.get(row) ?? row),
      NO_IDS,
      kinds,
      unit,
      finishMobileNativeChatMessages
    )
    if (
      unit.orphans.length ||
      rebuilt.orphans.length ||
      rebuilt.rows.length !== unit.rows.length ||
      rebuilt.rows.some((row, offset) => row.id !== unit.rows[offset]!.id)
    ) {
      return null
    }
    const start = at.get(unit.sources[0]!.id)!.start
    rebuilt.rows.forEach((row, offset) => {
      rows[start + offset] = row
      changed.push(start + offset)
    })
  }
  noteStreamedTextRevision(rows, base.rows, changed)
  const result = { ...base, input, rows }
  bases.set(result, base)
  return result
}

const NO_IDS: ReadonlySet<string> = new Set()
