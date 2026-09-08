import { useCallback, useEffect, useRef } from 'react'
import { normalizeMobileWebExternalUrl } from '../../../src/shared/mobile-web/native-operation-contract'
import { normalizeMobileRichMarkdownKeyboardInset } from './mobile-rich-markdown-editor-keyboard-inset-script'
import type {
  MobileRichMarkdownCommand,
  MobileRichMarkdownEditorMessage,
  MobileRichMarkdownEditorProps,
  MobileRichMarkdownEditorTransport
} from './mobile-rich-markdown-editor-contract'

export function useMobileRichMarkdownEditorController({
  content,
  editable,
  onChange,
  onKeyboardInsetChange,
  onOpenLink,
  transport
}: MobileRichMarkdownEditorProps & {
  transport: MobileRichMarkdownEditorTransport
}) {
  const readyRef = useRef(false)
  const documentGenerationRef = useRef(0)
  const currentEditorContentRef = useRef<string | null>(null)

  const applyContent = useCallback(
    (nextContent: string) => {
      documentGenerationRef.current += 1
      currentEditorContentRef.current = nextContent
      transport.setMarkdown(nextContent, documentGenerationRef.current)
    },
    [transport]
  )

  useEffect(() => {
    if (readyRef.current && currentEditorContentRef.current !== content) {
      applyContent(content)
    }
  }, [applyContent, content])

  useEffect(() => {
    if (readyRef.current) {
      transport.setEditable(editable)
    }
  }, [editable, transport])

  useEffect(() => {
    return () => onKeyboardInsetChange?.(0)
  }, [onKeyboardInsetChange])

  const handleMessage = useCallback(
    (message: Partial<MobileRichMarkdownEditorMessage>) => {
      if (message.type === 'ready') {
        readyRef.current = true
        // Why: an iframe load event can precede WebKit installing the editor's message listener.
        applyContent(content)
        transport.setEditable(editable)
        return
      }
      if (
        message.type === 'change' &&
        typeof message.markdown === 'string' &&
        message.generation === documentGenerationRef.current
      ) {
        currentEditorContentRef.current = message.markdown
        onChange(message.markdown)
        return
      }
      if (message.type === 'openLink' && typeof message.url === 'string') {
        const url = normalizeMobileWebExternalUrl(message.url)
        if (url) {
          onOpenLink?.(url)
        }
        return
      }
      if (message.type === 'keyboardInset' && typeof message.bottom === 'number') {
        const bottom = normalizeMobileRichMarkdownKeyboardInset(message.bottom)
        if (bottom !== null) {
          onKeyboardInsetChange?.(bottom)
        }
      }
    },
    [applyContent, content, editable, onChange, onKeyboardInsetChange, onOpenLink, transport]
  )

  const runCommand = useCallback(
    (command: MobileRichMarkdownCommand) => transport.runCommand(command),
    [transport]
  )

  return { handleMessage, runCommand }
}
