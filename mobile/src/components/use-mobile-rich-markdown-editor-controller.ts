import { useCallback, useEffect, useRef } from 'react'
import { normalizeMobileRichMarkdownKeyboardInset } from './mobile-rich-markdown-editor-keyboard-inset-script'
import type {
  MobileRichMarkdownCommand,
  MobileRichMarkdownEditorMessage,
  MobileRichMarkdownEditorProps,
  MobileRichMarkdownEditorTransport
} from './mobile-rich-markdown-editor-contract'

export function normalizeExternalEditorUrl(value: string): string | null {
  const url = value.trim()
  if (!url) {
    return null
  }
  for (let index = 0; index < url.length; index += 1) {
    const code = url.charCodeAt(index)
    if (code <= 32 || code === 127) {
      return null
    }
  }
  if (/^mailto:/i.test(url)) {
    return url
  }
  if (!/^https?:\/\//i.test(url)) {
    return null
  }
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

export function useMobileRichMarkdownEditorController({
  content,
  editable,
  onChange,
  onKeyboardInsetChange,
  onOpenLink,
  transport
}: MobileRichMarkdownEditorProps & { transport: MobileRichMarkdownEditorTransport }) {
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

  // Clear any reported keyboard inset when the editor unmounts so a lifted
  // Save/Discard bar settles back once the tab closes.
  useEffect(() => {
    return () => onKeyboardInsetChange?.(0)
  }, [onKeyboardInsetChange])

  const handleMessage = useCallback(
    (message: Partial<MobileRichMarkdownEditorMessage>) => {
      if (message.type === 'ready') {
        readyRef.current = true
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
        const url = normalizeExternalEditorUrl(message.url)
        if (url) {
          onOpenLink(url)
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
