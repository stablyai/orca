import {
  isTextBlock,
  type NativeChatMessage
} from '../../../../../../src/shared/native-chat/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../../../src/shared/native-chat/transcript/row-content/native-chat-row-content'
import { parseMobileMarkdownTree } from '../../../../components/mobile-markdown-tree'
import { protectMobileMarkdownVisualLines } from '../../../../components/mobile-markdown-visual-lines'
import { mobileMarkdownImageSources } from '../../../../components/mobile-markdown-image-placement'
import { mobileNativeChatMarkdownImageBlock } from './mobile-native-chat-markdown-image-block'

function sourceReader(visuals: boolean) {
  const sources = new WeakMap<NativeChatMessage['blocks'], readonly string[]>()
  return function imageSources(message: NativeChatMessage): readonly string[] {
    const cached = sources.get(message.blocks)
    if (cached) {
      return cached
    }
    const images = deriveNativeChatRowContent(message.blocks).prose.flatMap((block) => {
      if (!isTextBlock(block)) {
        return []
      }
      const content = block.text.trim()
      const text = visuals ? protectMobileMarkdownVisualLines(content).text : content
      return mobileMarkdownImageSources(
        parseMobileMarkdownTree(text, false, true),
        (href) => mobileNativeChatMarkdownImageBlock(href, '') !== null
      )
    })
    sources.set(message.blocks, images)
    return images
  }
}

export const mobileNativeChatMarkdownImageSources = sourceReader(false)
export const mobileNativeChatVisualMarkdownImageSources = sourceReader(true)
