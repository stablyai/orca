import type { Root, RootContent } from 'mdast'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../../src/shared/native-chat/transcript/native-chat-row-content'
import { parseMobileMarkdownTree } from '../../../components/mobile-markdown-tree'

const sources = new WeakMap<NativeChatMessage['blocks'], readonly string[]>()

export function mobileNativeChatMarkdownImageSources(
  message: NativeChatMessage
): readonly string[] {
  const cached = sources.get(message.blocks)
  if (cached) {
    return cached
  }
  const images: string[] = []
  function collect(node: Root | RootContent): void {
    if (node.type === 'image') {
      images.push(node.url)
    }
    if ('children' in node) {
      for (const child of node.children) {
        collect(child)
      }
    }
  }
  collect(parseMobileMarkdownTree(deriveNativeChatRowContent(message.blocks).markdown, false, true))
  sources.set(message.blocks, images)
  return images
}
