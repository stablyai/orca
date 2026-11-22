import { useMemo, type ReactNode } from 'react'
import { View } from 'react-native'
import { nativeChatProseToMarkdown } from '../../../../../../src/shared/native-chat/transcript/row-content/native-chat-prose'
import {
  isTextBlock,
  type NativeChatBlock
} from '../../../../../../src/shared/native-chat/native-chat-types'
import {
  useMobileNativeChatPacedText,
  type MobileNativeChatPacedText
} from './use-mobile-native-chat-paced-text'
import { styles } from '../messages/mobile-native-chat-message-styles'
import { NATIVE_CHAT_QUOTE_SOURCE_DATASET } from '../../../../../../src/shared/native-chat/input/quotes/native-chat-quote-selection'

const QUOTE_SOURCE_PROPS = { dataSet: NATIVE_CHAT_QUOTE_SOURCE_DATASET }

// Keep frame-driven reveal renders inside this message’s prose subtree.
export function MobileNativeChatPacedProse({
  rowKey,
  blocks,
  growingBlock,
  paced,
  savedRevision,
  children
}: {
  rowKey: string
  blocks: NativeChatBlock[]
  growingBlock: NativeChatBlock | undefined
  paced: boolean
  /** The row's saved journal revision, where it has one. */
  savedRevision?: number
  children: (block: NativeChatBlock, index: number, shown: MobileNativeChatPacedText) => ReactNode
}): React.JSX.Element {
  const source = useMemo(() => nativeChatProseToMarkdown(blocks), [blocks])
  const shown = useMobileNativeChatPacedText(
    rowKey,
    source,
    growingBlock?.type === 'text',
    paced,
    savedRevision
  )
  let end = 0
  const rows = blocks.map((block, index) => {
    const text = isTextBlock(block) ? block.text : ''
    // Match the canonical join while preserving independently parsed blocks and attachment order.
    const start = end + (end > 0 && text.length > 0 ? 2 : 0)
    end = start + text.length
    const content = shown.text.slice(start, end)
    return children(block, index, {
      text: content,
      revealing: shown.revealing && (block === growingBlock || content.length < text.length)
    })
  })
  // A paced (agent) reply is one quote source, as desktop's message row is, so a selection may span its blocks.
  return paced && blocks.length > 0 ? (
    <View style={styles.content} {...QUOTE_SOURCE_PROPS}>
      {rows}
    </View>
  ) : (
    <>{rows}</>
  )
}
