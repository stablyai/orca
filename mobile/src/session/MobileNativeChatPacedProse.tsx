import { useMemo, type ReactNode } from 'react'
import { nativeChatProseToMarkdown } from '../../../src/shared/native-chat-prose'
import { isTextBlock, type NativeChatBlock } from '../../../src/shared/native-chat-types'
import {
  useMobileNativeChatPacedText,
  type MobileNativeChatPacedText
} from './use-mobile-native-chat-paced-text'

/** One message owns the reveal; frames redraw only its prose subtree. */
export function MobileNativeChatPacedProse({
  rowKey,
  blocks,
  growingBlock,
  paced,
  children
}: {
  rowKey: string
  blocks: NativeChatBlock[]
  growingBlock: NativeChatBlock | undefined
  paced: boolean
  children: (block: NativeChatBlock, index: number, shown: MobileNativeChatPacedText) => ReactNode
}): React.JSX.Element {
  const source = useMemo(() => nativeChatProseToMarkdown(blocks), [blocks])
  const shown = useMobileNativeChatPacedText(rowKey, source, growingBlock?.type === 'text', paced)
  let end = 0
  return (
    <>
      {blocks.map((block, index) => {
        const text = isTextBlock(block) ? block.text : ''
        // Match the canonical join while preserving independently parsed blocks and attachment order.
        const start = end + (end > 0 && text.length > 0 ? 2 : 0)
        end = start + text.length
        const content = shown.text.slice(start, end)
        return children(block, index, {
          text: content,
          revealing: shown.revealing && (block === growingBlock || content.length < text.length)
        })
      })}
    </>
  )
}
