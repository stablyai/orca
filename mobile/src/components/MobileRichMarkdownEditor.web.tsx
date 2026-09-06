import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import type {
  MobileRichMarkdownEditorFrameMessage,
  MobileRichMarkdownEditorProps,
  MobileRichMarkdownEditorTransport
} from './mobile-rich-markdown-editor-contract'
import { MOBILE_RICH_MARKDOWN_EDITOR_CHANNEL } from './mobile-rich-markdown-editor-contract'
import { buildMobileRichMarkdownEditorHtml } from './mobile-rich-markdown-editor-html'
import {
  MobileRichMarkdownEditorPresentation,
  mobileRichMarkdownEditorSurfaceStyle
} from './mobile-rich-markdown-editor-presentation'
import { useMobileRichMarkdownEditorController } from './use-mobile-rich-markdown-editor-controller'

function createFrameToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function MobileRichMarkdownEditorWeb({
  content,
  editable,
  onChange,
  onKeyboardInsetChange,
  onOpenLink
}: MobileRichMarkdownEditorProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const frameToken = useMemo(() => createFrameToken(), [])
  const documentUrl = useMemo(
    () =>
      `data:text/html;charset=utf-8,${encodeURIComponent(
        buildMobileRichMarkdownEditorHtml({ isolatedFrame: true })
      )}`,
    []
  )

  const postToEditor = useCallback(
    (
      payload: Extract<
        MobileRichMarkdownEditorFrameMessage,
        { direction: 'host-to-editor' }
      >['payload']
    ) => {
      const message: MobileRichMarkdownEditorFrameMessage = {
        channel: MOBILE_RICH_MARKDOWN_EDITOR_CHANNEL,
        frameToken,
        direction: 'host-to-editor',
        payload
      }
      frameRef.current?.contentWindow?.postMessage(message, '*')
    },
    [frameToken]
  )

  const transport = useMemo<MobileRichMarkdownEditorTransport>(
    () => ({
      setMarkdown(markdown, generation) {
        postToEditor({ type: 'setMarkdown', markdown, generation })
      },
      setEditable(nextEditable) {
        postToEditor({ type: 'setEditable', editable: nextEditable })
      },
      runCommand(command) {
        postToEditor({ type: 'runCommand', command })
      }
    }),
    [postToEditor]
  )
  const { handleMessage, runCommand } = useMobileRichMarkdownEditorController({
    content,
    editable,
    onChange,
    onKeyboardInsetChange,
    onOpenLink,
    transport
  })

  useEffect(() => {
    const receiveMessage = (event: MessageEvent<unknown>) => {
      if (!event.data || typeof event.data !== 'object') {
        return
      }
      const message = event.data as Partial<MobileRichMarkdownEditorFrameMessage>
      if (
        message.channel === MOBILE_RICH_MARKDOWN_EDITOR_CHANNEL &&
        message.frameToken === frameToken &&
        message.direction === 'editor-to-host' &&
        message.payload &&
        typeof message.payload === 'object'
      ) {
        handleMessage(message.payload)
      }
    }
    window.addEventListener('message', receiveMessage)
    return () => window.removeEventListener('message', receiveMessage)
  }, [frameToken, handleMessage])

  return (
    <MobileRichMarkdownEditorPresentation
      editable={editable}
      onCommand={runCommand}
      editor={
        <iframe
          ref={frameRef}
          title="Markdown editor"
          aria-label="Markdown editor"
          src={documentUrl}
          name={frameToken}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={() => handleMessage({ type: 'ready' })}
          style={{
            ...mobileRichMarkdownEditorSurfaceStyle,
            width: '100%',
            height: '100%',
            border: 0,
            display: 'block'
          }}
        />
      }
    />
  )
}

export const MobileRichMarkdownEditor = memo(MobileRichMarkdownEditorWeb)
