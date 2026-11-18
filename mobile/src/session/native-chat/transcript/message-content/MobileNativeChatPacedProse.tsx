import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
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
import { createNativeChatRedrawPaceHook } from '../../../../../../src/shared/native-chat/transcript/row-content/use-native-chat-redraw-pace'
import { NATIVE_CHAT_QUOTE_SOURCE_DATASET } from '../../../../../../src/shared/native-chat/input/quotes/native-chat-quote-selection'

const useNativeChatRedrawPace = createNativeChatRedrawPaceHook({
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef
})

const QUOTE_SOURCE_PROPS = { dataSet: NATIVE_CHAT_QUOTE_SOURCE_DATASET }

// Keep frame-driven reveal renders inside this message’s prose subtree.
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
  const drawn = useNativeChatRedrawPace(shown.text, shown.revealing)
  let end = 0
  const rows = blocks.map((block, index) => {
    const text = isTextBlock(block) ? block.text : ''
    // Match the canonical join while preserving independently parsed blocks and attachment order.
    const start = end + (end > 0 && text.length > 0 ? 2 : 0)
    end = start + text.length
    const content = drawn.slice(start, end)
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
