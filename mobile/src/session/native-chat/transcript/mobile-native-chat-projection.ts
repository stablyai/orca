import type { AgentType } from '../../../../../src/shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { getVerifiedNativeChatCommands } from '../../../../../src/shared/native-chat/native-chat-agent-profiles'
import { surfaceSkillInvocationUserTurns } from '../../../../../src/shared/native-chat/native-chat-command-envelope'
import {
  nativeChatToolFoldKind,
  type NativeChatToolFoldKind
} from '../../../../../src/shared/native-chat/tools/native-chat-tool-fold'
import { foldSubagentItems } from '../../../../../src/shared/native-chat/transcript/native-chat-subagent-items'
import {
  nativeChatImageTranscriptUnits,
  normalizeImageTranscriptUnit
} from '../../../../../src/shared/native-chat/transcript/native-chat-image-transcript-markers'
import {
  nativeChatCommandName,
  nativeChatCommandOutputParentId,
  surfaceNativeChatCommandOutputs
} from '../../../../../src/shared/native-chat/tools/native-chat-command-output'
import {
  foldMobileNativeChatMessages,
  isMobileNativeChatSource
} from '../mobile-native-chat-render-data'
import { buildMobileNativeChatUnits, type Unit } from './mobile-native-chat-projection-units'

type Source = {
  raw: NativeChatMessage
  skill?: NativeChatMessage
  parentId?: string | null
  parentCommand?: string | null
  harness?: NativeChatMessage
}
type ImageUnit = { sources: readonly NativeChatMessage[]; rows: NativeChatMessage[] }
export type MobileNativeChatProjection = {
  input: readonly NativeChatMessage[]
  agent: AgentType
  sources: ReadonlyMap<string, Source>
  images: readonly ImageUnit[]
  kinds: ReadonlyMap<NativeChatMessage, NativeChatToolFoldKind>
  units: readonly Unit[]
  rows: NativeChatMessage[]
}

type JournalPosition = NonNullable<NativeChatMessage['journalPosition']>

function samePosition(left: JournalPosition, right: JournalPosition): boolean {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Own enumerable keys are used only to compare the same fields on both positions.
  const keys = Object.keys(left) as (keyof JournalPosition)[]
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]))
  )
}

function sameSource(left: NativeChatMessage, right: NativeChatMessage): boolean {
  if (left === right) {
    return true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Own enumerable keys are used only to compare the same fields on both messages.
  const keys = Object.keys(left) as (keyof NativeChatMessage)[]
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => {
      if (!Object.hasOwn(right, key)) {
        return false
      }
      if (key === 'journalPosition' || key === 'foldedJournalPosition') {
        const a = left[key],
          b = right[key]
        return Object.is(a, b) || (a != null && b != null && samePosition(a, b))
      }
      return Object.is(left[key], right[key])
    })
  )
}

function prepareSources(
  input: readonly NativeChatMessage[],
  agent: AgentType,
  previous?: MobileNativeChatProjection
): Map<string, Source> {
  const commands = new Set(getVerifiedNativeChatCommands(agent).map((command) => command.name))
  const sources = new Map<string, Source>()
  for (const candidate of input) {
    const before = previous?.sources.get(candidate.id)
    if (before && sameSource(before.raw, candidate)) {
      sources.set(candidate.id, before)
      continue
    }
    if (!isMobileNativeChatSource(candidate)) {
      sources.set(candidate.id, { raw: candidate })
      continue
    }
    const skill = surfaceSkillInvocationUserTurns([candidate], commands)[0]!
    sources.set(candidate.id, {
      raw: candidate,
      skill,
      parentId: nativeChatCommandOutputParentId(skill)
    })
  }
  for (const [id, source] of sources) {
    if (!source.skill) {
      continue
    }
    const parent =
      source.parentId !== null && source.parentId !== undefined
        ? sources.get(source.parentId)
        : undefined
    const parentCommand = parent?.skill ? nativeChatCommandName(parent.skill) : null
    const before = previous?.sources.get(id)
    if (before?.skill === source.skill && before.parentCommand === parentCommand) {
      continue
    }
    const context =
      parent?.skill && parent.skill !== source.skill ? [source.skill, parent.skill] : [source.skill]
    sources.set(id, {
      ...source,
      parentCommand,
      harness: surfaceNativeChatCommandOutputs(context, agent)[0]!
    })
  }
  return sources
}

/** One disposable generation; unchanged history contributes references, never semantic replay. */
export function projectMobileNativeChatMessages(
  input: readonly NativeChatMessage[],
  agent: AgentType,
  previous?: MobileNativeChatProjection
): MobileNativeChatProjection {
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
  if (previous && (previous.agent !== agent || previous.sources.size !== previous.input.length)) {
    previous = undefined
  }
  if (previous) {
    const survivors = [...previous.sources.keys()].filter((id) => ids.has(id))
    let cursor = 0
    if (input.some((row) => previous!.sources.has(row.id) && survivors[cursor++] !== row.id)) {
      previous = undefined
    }
  }
  const sources = prepareSources(input, agent, previous)
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
  const units = buildMobileNativeChatUnits(grouped, kinds, previous)
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
