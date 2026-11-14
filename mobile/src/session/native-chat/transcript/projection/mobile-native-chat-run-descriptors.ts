import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { NativeChatResolvedPrompt } from '../../../../../../src/shared/native-chat/native-chat-resolution-receipt'
import { splitNativeChatBlocks } from '../../../../../../src/shared/native-chat/tools/native-chat-tool-fold'
import { nativeChatWorkRunEntries } from '../../../../../../src/shared/native-chat/native-chat-work-run'
import { nativeChatAskRunBlocks } from '../../../../../../src/shared/native-chat/input/questions/native-chat-ask-row'
import type { MobileNativeChatWorkRuns } from '../turn-state/use-mobile-native-chat-transcript-rows'
import type { MobileNativeChatRowSources } from './mobile-native-chat-row-keys'

export type MobileNativeChatRunPresentation = {
  rows: readonly NativeChatMessage[]
  workRuns: MobileNativeChatWorkRuns
  turnKeys: readonly (string | undefined)[]
  receipts?: ReadonlyMap<string, NativeChatResolvedPrompt> | null
}

type Run = { index: number; row: NativeChatMessage; sources: MobileNativeChatRowSources }
export type MobileNativeChatRunHistory = {
  presentation?: MobileNativeChatRunPresentation
  messages: readonly NativeChatMessage[]
  runs: readonly Run[]
}

export function mobileNativeChatRunDescriptors(
  { rows, workRuns, turnKeys, receipts }: MobileNativeChatRunPresentation,
  sourceOf: (row: NativeChatMessage) => MobileNativeChatRowSources,
  from = 0
): Run[] {
  return rows.slice(from).flatMap((row, offset) => {
    const index = from + offset
    if (workRuns.joined.has(index) || receipts?.has(row.id)) {
      return []
    }
    const members = workRuns.heads.get(index)
    if (row.role === 'reasoning' && !members) {
      return []
    }
    const tools = members
      ? nativeChatWorkRunEntries(members).blocks
      : splitNativeChatBlocks(row.blocks).tools
    if (nativeChatAskRunBlocks(tools).work.length === 0) {
      return []
    }
    const content = [...new Set((members ?? [row]).flatMap((member) => sourceOf(member).content))]
    const own = content.filter((source) => !source.startsWith('result:'))
    const scoped = (source: string) => `${source}\0${turnKeys[index] ?? ''}`
    return [
      {
        index,
        row,
        sources: {
          identity: (own.length ? own : content).map(scoped),
          content: content.map(scoped)
        }
      }
    ]
  })
}

function sameList<T>(left: readonly T[] | undefined, right: readonly T[] | undefined): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.length === right.length &&
      left.every((item, index) => item === right[index]))
  )
}

// Earliest row whose run may differ: its inputs changed, or it holds a block whose owning message changed.
function firstChangedRun(
  previous: MobileNativeChatRunHistory,
  presentation: MobileNativeChatRunPresentation,
  messages: readonly NativeChatMessage[]
): number {
  const old = previous.presentation
  if (!old || old.receipts !== presentation.receipts) {
    return 0
  }
  const { rows, workRuns, turnKeys } = presentation
  const limit = Math.min(rows.length, old.rows.length)
  let from = 0
  while (
    from < limit &&
    rows[from] === old.rows[from] &&
    turnKeys[from] === old.turnKeys[from] &&
    workRuns.joined.has(from) === old.workRuns.joined.has(from) &&
    sameList(workRuns.heads.get(from), old.workRuns.heads.get(from))
  ) {
    from += 1
  }
  let same = 0
  const was = previous.messages
  while (same < was.length && same < messages.length && was[same] === messages[same]) {
    same += 1
  }
  if (was.length - same > 4 || messages.length - same > 4) {
    return 0
  }
  // Blocks first seen in an unchanged message keep their owner; only the changed tail can move one.
  const moved = new Set([...was.slice(same), ...messages.slice(same)].flatMap((m) => m.blocks))
  if (moved.size === 0) {
    return from
  }
  const hit = previous.runs.find(
    (run) =>
      run.index < from &&
      (old.workRuns.heads.get(run.index) ?? [run.row]).some((member) =>
        member.blocks.some((block) => moved.has(block))
      )
  )
  return hit?.index ?? from
}

export function sameMobileNativeChatRun(left: Run, right: Run): boolean {
  return (
    left === right ||
    (left.row.id === right.row.id &&
      sameList(left.sources.identity, right.sources.identity) &&
      sameList(left.sources.content, right.sources.content))
  )
}

// Heads that share no identity source each inherit their own key when the same runs come again.
export function distinctMobileNativeChatRunIdentities(runs: readonly Run[]): boolean {
  const seen = new Set<string>()
  for (const { sources } of runs) {
    for (const source of sources.identity) {
      if (seen.has(source)) {
        return false
      }
      seen.add(source)
    }
  }
  return true
}

/** Keeps the runs above the first row whose run may differ and describes the rest again. */
export function updateMobileNativeChatRunDescriptors(
  previous: MobileNativeChatRunHistory | null,
  presentation: MobileNativeChatRunPresentation,
  messages: readonly NativeChatMessage[],
  sourceOf: (row: NativeChatMessage) => MobileNativeChatRowSources
): Run[] {
  const from = previous ? firstChangedRun(previous, presentation, messages) : 0
  return [
    ...(previous?.runs.filter((run) => run.index < from) ?? []),
    ...mobileNativeChatRunDescriptors(presentation, sourceOf, from)
  ]
}
