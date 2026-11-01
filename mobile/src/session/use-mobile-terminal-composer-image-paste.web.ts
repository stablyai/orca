import { useEffect, useRef, useState, type RefObject } from 'react'
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
  readonly onImagePaste: () => void | Promise<void>
  readonly readClipboardImage: () => Promise<{ base64: string } | null>
}): boolean {
  const argsRef = useRef(args)
  argsRef.current = args
  const { enabled, fieldRefs } = args
  const [pastePending, setPastePending] = useState(false)
  const pendingCount = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const startPaste = (): void => {
    pendingCount.current += 1
    setPastePending(true)
  }
  const finishPaste = (): void => {
    pendingCount.current = Math.max(0, pendingCount.current - 1)
    if (mounted.current && pendingCount.current === 0) {
      setPastePending(false)
    }
  }
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
      startPaste()
      if (claimed.kind === 'files') {
        void Promise.resolve(argsRef.current.onImagePaste()).finally(finishPaste)
        return
      }
      // An empty textarea paste is how iOS hides a pasteboard image. No image means a no-op.
      void argsRef.current
        .readClipboardImage()
        .then((image) => {
          if (image) {
            return argsRef.current.onImagePaste()
          }
          return undefined
        })
        .finally(finishPaste)
    }
    document.addEventListener('paste', onPaste, true)
    return () => document.removeEventListener('paste', onPaste, true)
  }, [enabled, fieldRefs])
  return pastePending
}
