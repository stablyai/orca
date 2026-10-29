import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { NativeChatResolvedPrompt } from '../../../src/shared/native-chat-resolution-receipt'
import { splitNativeChatBlocks } from '../../../src/shared/native-chat/tools/native-chat-tool-fold'
import { nativeChatWorkRunEntries } from '../../../src/shared/native-chat/native-chat-work-run'
import { nativeChatAskRunBlocks } from '../../../src/shared/native-chat/input/native-chat-ask-row'
import type { MobileNativeChatWorkRuns } from './native-chat/transcript/use-mobile-native-chat-transcript-rows'
import type { MobileNativeChatRowSources } from './native-chat/transcript/mobile-native-chat-row-keys'

export type MobileNativeChatRunPresentation = {
  rows: readonly NativeChatMessage[]
  workRuns: MobileNativeChatWorkRuns
  turnKeys: readonly (string | undefined)[]
  receipts?: ReadonlyMap<string, NativeChatResolvedPrompt> | null
}

export function mobileNativeChatRunDescriptors(
  { rows, workRuns, turnKeys, receipts }: MobileNativeChatRunPresentation,
  sourceOf: (row: NativeChatMessage) => MobileNativeChatRowSources
) {
  return rows.flatMap((row, index) => {
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
        row,
        sources: {
          identity: (own.length ? own : content).map(scoped),
          content: content.map(scoped)
        }
      }
    ]
  })
}
