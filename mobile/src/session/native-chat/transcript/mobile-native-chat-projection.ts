import type { AgentType } from '../../../../../src/shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import {
  nativeChatToolFoldKind,
  type NativeChatToolFoldKind
} from '../../../../../src/shared/native-chat/tools/native-chat-tool-fold'
import { foldSubagentItems } from '../../../../../src/shared/native-chat/transcript/subagents/native-chat-subagent-items'
import {
  nativeChatImageTranscriptUnits,
  normalizeImageTranscriptUnit
} from '../../../../../src/shared/native-chat/transcript/images/native-chat-image-transcript-markers'
import {
  finishMobileNativeChatMessages,
  foldMobileNativeChatMessages
} from './mobile-native-chat-render-data'
import {
  prepareMobileNativeChatSources,
  type MobileNativeChatProjectionSource
} from './mobile-native-chat-projection-sources'
import { projectMobileNativeChatTail } from './mobile-native-chat-projection-tail'
import {
  buildNativeChatFoldUnits,
  type NativeChatFoldUnit as Unit
} from '../../../../../src/shared/native-chat/transcript/folding/native-chat-fold-units'

type ImageUnit = { sources: readonly NativeChatMessage[]; rows: NativeChatMessage[] }
export type MobileNativeChatProjection = {
  input: readonly NativeChatMessage[]
  agent: AgentType
  sources: ReadonlyMap<string, MobileNativeChatProjectionSource>
  images: readonly ImageUnit[]
  kinds: ReadonlyMap<NativeChatMessage, NativeChatToolFoldKind>
  units: readonly Unit[]
  rows: NativeChatMessage[]
}

/** One disposable generation; unchanged history contributes references, never semantic replay. */
export function projectMobileNativeChatMessages(
  input: readonly NativeChatMessage[],
  agent: AgentType,
  previous?: MobileNativeChatProjection
): MobileNativeChatProjection {
  if (previous && (previous.agent !== agent || previous.sources.size !== previous.input.length)) {
    previous = undefined
  }
  const tail = previous && projectMobileNativeChatTail(input, agent, previous)
  if (tail) {
    return tail
  }
  const ids = new Set(input.map((row) => row.id))
  if (ids.size !== input.length) {
    return {
      input,
      agent,
      sources: new Map(),
      images: [],
      kinds: new Map(),
      units: [],
      rows: foldMobileNativeChatMessages(input, agent)
    }
  }
  if (previous) {
    const survivors = [...previous.sources.keys()].filter((id) => ids.has(id))
    let cursor = 0
    if (input.some((row) => previous!.sources.has(row.id) && survivors[cursor++] !== row.id)) {
      previous = undefined
    }
  }
  const sources = prepareMobileNativeChatSources(input, agent, previous)
  const harness = [...sources.values()].flatMap((source) => source.harness ?? [])
  const oldImages = new Map(previous?.images.map((unit) => [unit.sources[0]!, unit]))
  const images = nativeChatImageTranscriptUnits(harness).map((members) => {
    const held = oldImages.get(members[0]!)
    return held &&
      held.sources.length === members.length &&
      held.sources.every((source, index) => source === members[index])
      ? held
      : { sources: members, rows: normalizeImageTranscriptUnit(members) }
  })
  const grouped = foldSubagentItems(images.flatMap((unit) => unit.rows))
  const kinds = new Map(
    grouped.map((source) => [source, previous?.kinds.get(source) ?? nativeChatToolFoldKind(source)])
  )
  const units = buildNativeChatFoldUnits(
    grouped,
    kinds,
    new Map(previous?.units.map((unit) => [unit.sources[0]!.id, unit])),
    finishMobileNativeChatMessages
  )
  const unchanged =
    previous &&
    units.length === previous.units.length &&
    units.every((unit, index) => unit === previous!.units[index])
  return {
    input,
    agent,
    sources,
    images,
    kinds,
    units,
    rows: previous && unchanged ? previous.rows : units.flatMap((unit) => unit.rows)
  }
}
