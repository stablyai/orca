import type { AgentType } from '../../../../../src/shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { nativeChatToolFoldKind } from '../../../../../src/shared/native-chat/tools/native-chat-tool-fold'
import { isOrphanRowId } from '../../../../../src/shared/native-chat/tools/native-chat-folded-tool-results'
import { subagentItemBlock } from '../../../../../src/shared/native-chat/transcript/subagents/native-chat-subagent-items'
import {
  hasImagePromptMarker,
  imageSourcePathsFromMessage,
  normalizeImageTranscriptUnit
} from '../../../../../src/shared/native-chat/transcript/images/native-chat-image-transcript-markers'
import type { MobileNativeChatProjection } from './mobile-native-chat-projection'
import {
  prepareMobileNativeChatSource,
  verifiedMobileNativeChatCommands,
  withMobileNativeChatHarness
} from './mobile-native-chat-projection-sources'
import {
  buildNativeChatFoldUnit,
  groupNativeChatFoldUnitMembers,
  type NativeChatFoldUnit as Unit
} from '../../../../../src/shared/native-chat/transcript/folding/native-chat-fold-units'
import { finishMobileNativeChatMessages } from './mobile-native-chat-render-data'

// A tail harness row that is its own image unit and no roster member leaves every earlier unit as it was.
function staysInTail(harness: NativeChatMessage): boolean {
  return (
    imageSourcePathsFromMessage(harness).length === 0 &&
    !(harness.role === 'user' && hasImagePromptMarker(harness))
  )
}

function rowStaysInTail(row: NativeChatMessage): boolean {
  return subagentItemBlock(row) === null && !isOrphanRowId(row.id)
}

/** Streaming replaces the last message or appends one: re-project only the last unit or two, or null for a full pass. */
export function projectMobileNativeChatTail(
  input: readonly NativeChatMessage[],
  agent: AgentType,
  previous: MobileNativeChatProjection
): MobileNativeChatProjection | null {
  const candidate = input.at(-1)
  const kept = input.length - 1
  if (!candidate || (kept !== previous.input.length && kept !== previous.input.length - 1)) {
    return null
  }
  const replaced = previous.input[kept]
  if (replaced ? replaced.id !== candidate.id : previous.sources.has(candidate.id)) {
    return null
  }
  for (let index = 0; index < kept; index += 1) {
    if (input[index] !== previous.input[index]) {
      return null
    }
  }
  const before = previous.sources.get(candidate.id)
  for (const source of previous.sources.values()) {
    if (source.parentId === candidate.id && source !== before) {
      return null
    }
  }
  const sources = new Map(previous.sources)
  const prepared = prepareMobileNativeChatSource(
    candidate,
    verifiedMobileNativeChatCommands(agent),
    before
  )
  // Set before harnessing: a message may name itself as its command parent.
  sources.set(candidate.id, prepared)
  const source = withMobileNativeChatHarness(prepared, sources, agent, before)
  sources.set(candidate.id, source)
  const oldImage = before?.harness && previous.images.at(-1)
  if (
    oldImage &&
    (oldImage.sources.length !== 1 ||
      oldImage.sources[0] !== before.harness ||
      !staysInTail(before.harness))
  ) {
    return null
  }
  const harness = source.harness
  if (harness && !staysInTail(harness)) {
    return null
  }
  const image =
    harness && oldImage?.sources[0] === harness
      ? oldImage
      : harness && { sources: [harness], rows: normalizeImageTranscriptUnit([harness]) }
  const oldRows = oldImage?.rows ?? []
  const newRows = image?.rows ?? []
  if (
    oldRows.length > 1 ||
    newRows.length > 1 ||
    !oldRows.every(rowStaysInTail) ||
    !newRows.every(rowStaysInTail)
  ) {
    return null
  }
  const kinds = new Map(previous.kinds)
  oldRows.forEach((row) => kinds.delete(row))
  newRows.forEach((row) => kinds.set(row, previous.kinds.get(row) ?? nativeChatToolFoldKind(row)))
  // Units start where the scan starts a group, so re-scan from the last head (one earlier if the replaced row was it).
  const headReplaced = oldRows.length > 0 && previous.units.at(-1)?.sources[0] === oldRows[0]
  const from = Math.max(0, previous.units.length - (headReplaced ? 2 : 1))
  const dropped = previous.units.slice(from)
  const rescan = dropped.flatMap((unit) => unit.sources)
  if (oldRows.length > 0 && rescan.pop() !== oldRows[0]) {
    return null
  }
  rescan.push(...newRows)
  // Orphan names depend on every earlier id, so a re-projected unit with orphans takes the full pass.
  const rebuilt: Unit[] = []
  for (const members of groupNativeChatFoldUnitMembers(rescan, kinds)) {
    const held = previous.units.findLast((unit) => unit.sources[0]!.id === members[0]!.id)
    const unit = buildNativeChatFoldUnit(
      members,
      NO_IDS,
      kinds,
      held,
      finishMobileNativeChatMessages
    )
    if (unit !== held && unit.orphans.length > 0) {
      return null
    }
    rebuilt.push(unit)
  }
  const unchanged =
    rebuilt.length === dropped.length && rebuilt.every((unit, index) => unit === dropped[index])
  const keptRows = previous.rows.length - dropped.reduce((sum, unit) => sum + unit.rows.length, 0)
  return {
    input,
    agent,
    sources,
    images: [
      ...previous.images.slice(0, previous.images.length - (oldImage ? 1 : 0)),
      ...(image ? [image] : [])
    ],
    kinds,
    units: [...previous.units.slice(0, from), ...rebuilt],
    rows: unchanged
      ? previous.rows
      : [...previous.rows.slice(0, keptRows), ...rebuilt.flatMap((unit) => unit.rows)]
  }
}

const NO_IDS: ReadonlySet<string> = new Set()
