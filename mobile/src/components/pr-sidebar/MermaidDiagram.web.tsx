import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { colors } from '../../theme/mobile-theme'
import { MOBILE_WEB_MERMAID_FRAME_PATH } from '../../../../src/shared/mobile-web/mermaid-frame-document'
import {
  MERMAID_DIAGRAM_MAX_SOURCE_CHARACTERS,
  createMermaidDiagramEngineMessages,
  createMermaidDiagramInitializationMessage,
  parseMermaidDiagramMessage
} from './mermaid-diagram-contract'
import { MermaidDiagramPresentation } from './mermaid-diagram-presentation'
import { MERMAID_WEBVIEW_ENGINE_GZIP_BASE64 } from './mermaid-webview-engine.generated'

type Props = {
  source: string
  base: number
}

function createFrameToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function MermaidDiagram({ source, base }: Props) {
  return <MermaidDiagramFrame key={source} source={source} base={base} />
}

function MermaidDiagramFrame({ source, base }: Props) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const frameToken = useMemo(() => createFrameToken(), [])
  const [height, setHeight] = useState(0)
  const [failed, setFailed] = useState(source.length > MERMAID_DIAGRAM_MAX_SOURCE_CHARACTERS)
  const [frameStatus, setFrameStatus] = useState('loading')
  const initialization = useMemo(
    () =>
      createMermaidDiagramInitializationMessage(
        source,
        MERMAID_WEBVIEW_ENGINE_GZIP_BASE64,
        frameToken
      ),
    [frameToken, source]
  )
  const sendInitialization = useCallback(() => {
    const target = frameRef.current?.contentWindow
    if (target && initialization) {
      target.postMessage(initialization, '*')
    }
  }, [initialization])
  const sendEngine = useCallback(() => {
    const target = frameRef.current?.contentWindow
    if (!target) {
      return
    }
    for (const message of createMermaidDiagramEngineMessages(
      MERMAID_WEBVIEW_ENGINE_GZIP_BASE64,
      frameToken
    )) {
      target.postMessage(message, '*')
    }
  }, [frameToken])

  useEffect(() => {
    const retries = [0, 250, 1_000].map((delay) => window.setTimeout(sendInitialization, delay))
    const clearRetries = () => retries.forEach(window.clearTimeout)
    const receiveMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== frameRef.current?.contentWindow) {
        return
      }
      const message = parseMermaidDiagramMessage(event.data, frameToken)
      if (message?.type === 'ready') {
        clearRetries()
        setFrameStatus('ready')
        sendEngine()
      } else if (message?.type === 'assembled') {
        setFrameStatus('assembled')
      } else if (message?.type === 'error') {
        clearRetries()
        setFrameStatus('error')
        setFailed(true)
      } else if (message?.type === 'rendered') {
        clearRetries()
        setFrameStatus('rendered')
        setHeight(message.height)
      }
    }
    window.addEventListener('message', receiveMessage)
    return () => {
      clearRetries()
      window.removeEventListener('message', receiveMessage)
    }
  }, [frameToken, sendEngine, sendInitialization])

  return (
    <MermaidDiagramPresentation
      source={source}
      base={base}
      diagram={
        failed ? null : (
          <iframe
            ref={frameRef}
            title="Mermaid diagram"
            aria-label="Mermaid diagram"
            name={frameToken}
            src={`/${MOBILE_WEB_MERMAID_FRAME_PATH}`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            data-orca-mermaid-status={frameStatus}
            onLoad={() => {
              setFrameStatus('loaded')
              sendInitialization()
            }}
            style={{
              height: height || 120,
              width: '100%',
              border: 0,
              backgroundColor: colors.bgRaised
            }}
          />
        )
      }
    />
  )
}
