import { useEffect, useMemo, useRef } from 'react'
import {
  buildMobileHtmlPreviewDocument,
  parseMobileHtmlPreviewMessage
} from './mobile-html-preview-document'
import { MobileHtmlPreviewPresentation } from './mobile-html-preview-presentation'

type Props = {
  html: string
  onOpenLink?: (url: string) => void
  renderSource: () => React.ReactNode
}

function createFrameToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function MobileHtmlPreview({ html, onOpenLink, renderSource }: Props) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const frameToken = useMemo(() => createFrameToken(), [])
  const documentUrl = useMemo(
    () =>
      `data:text/html;charset=utf-8,${encodeURIComponent(buildMobileHtmlPreviewDocument(html))}`,
    [html]
  )

  useEffect(() => {
    const receiveMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== frameRef.current?.contentWindow) {
        return
      }
      const url = parseMobileHtmlPreviewMessage(event.data, frameToken)
      if (url) {
        onOpenLink?.(url)
      }
    }
    window.addEventListener('message', receiveMessage)
    return () => window.removeEventListener('message', receiveMessage)
  }, [frameToken, onOpenLink])

  return (
    <MobileHtmlPreviewPresentation
      renderSource={renderSource}
      preview={
        <iframe
          ref={frameRef}
          title="HTML preview"
          aria-label="HTML preview"
          name={frameToken}
          src={documentUrl}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          style={{ flex: 1, width: '100%', border: 0, backgroundColor: '#ffffff' }}
        />
      }
    />
  )
}
