import { useEffect, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import { claimMobileComposerImagePaste } from './native-chat/composer/mobile-native-chat-composer-image-paste-claim.web'

function textareaFrom(node: TextInput | null): HTMLTextAreaElement | HTMLInputElement | null {
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
    return node
  }
  return null
}

// Image-only pastes follow More Keys. Text pastes stay in the field, including a caption beside an image.
export function useMobileTerminalComposerImagePaste(args: {
  readonly enabled: boolean
  readonly fieldRefs: readonly RefObject<TextInput | null>[]
  readonly onImagePaste: () => void
  readonly readClipboardImage: () => Promise<{ base64: string } | null>
}): void {
  const argsRef = useRef(args)
  argsRef.current = args
  const { enabled, fieldRefs } = args
  useEffect(() => {
    if (!enabled) {
      return
    }
    const onPaste = (event: ClipboardEvent) => {
      const nodes = fieldRefs.flatMap((ref) => {
        const node = textareaFrom(ref.current)
        return node ? [node] : []
      })
      const target = event.target
      if (!(target instanceof Node) || !nodes.some((node) => node === target)) {
        return
      }
      if (event.defaultPrevented) {
        return
      }
      const claimed = claimMobileComposerImagePaste(event.clipboardData)
      if (!claimed) {
        return
      }
      if (claimed.kind === 'files' && claimed.promptText.length > 0) {
        return
      }
      event.preventDefault()
      if (claimed.kind === 'files') {
        argsRef.current.onImagePaste()
        return
      }
      // An empty textarea paste is how iOS hides a pasteboard image. No image means a no-op.
      void argsRef.current.readClipboardImage().then(
        (image) => {
          if (image) {
            argsRef.current.onImagePaste()
          }
        },
        () => undefined
      )
    }
    document.addEventListener('paste', onPaste, true)
    return () => document.removeEventListener('paste', onPaste, true)
  }, [enabled, fieldRefs])
}
