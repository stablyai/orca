import { memo, useMemo, useState } from 'react'
import { WebView } from 'react-native-webview'
import { buildMermaidDiagramDocument } from './mermaid-diagram-document'
import {
  MERMAID_DIAGRAM_MAX_SOURCE_CHARACTERS,
  parseMermaidDiagramMessage
} from './mermaid-diagram-contract'
import { MermaidDiagramPresentation, mermaidDiagramStyles } from './mermaid-diagram-presentation'

type Props = {
  source: string
  base: number
}

// memo: both props are primitives; without it every mounted diagram re-renders per frame
// during pinch-to-zoom (textScale updates), marshalling the full HTML string across the
// Fabric boundary each time.
export const MermaidDiagram = memo(function MermaidDiagram({ source, base }: Props) {
  return <MermaidDiagramFrame key={source} source={source} base={base} />
})

function MermaidDiagramFrame({ source, base }: Props) {
  const [height, setHeight] = useState(0)
  const [failed, setFailed] = useState(source.length > MERMAID_DIAGRAM_MAX_SOURCE_CHARACTERS)
  const html = useMemo(
    () =>
      source.length <= MERMAID_DIAGRAM_MAX_SOURCE_CHARACTERS
        ? buildMermaidDiagramDocument(source)
        : '',
    [source]
  )

  return (
    <MermaidDiagramPresentation
      source={source}
      base={base}
      diagram={
        failed ? null : (
          <WebView
            style={[mermaidDiagramStyles.webview, { height: height || 120 }]}
            originWhitelist={['about:blank']}
            source={{ html }}
            javaScriptEnabled
            javaScriptCanOpenWindowsAutomatically={false}
            scrollEnabled={false}
            domStorageEnabled={false}
            cacheEnabled={false}
            incognito
            setSupportMultipleWindows={false}
            allowFileAccess={false}
            allowFileAccessFromFileURLs={false}
            allowUniversalAccessFromFileURLs={false}
            mixedContentMode="never"
            sharedCookiesEnabled={false}
            thirdPartyCookiesEnabled={false}
            geolocationEnabled={false}
            mediaPlaybackRequiresUserAction
            onShouldStartLoadWithRequest={(request) => request.url === 'about:blank'}
            onError={() => setFailed(true)}
            onHttpError={() => setFailed(true)}
            onMessage={(event) => {
              const message = parseMermaidDiagramMessage(event.nativeEvent.data)
              if (message?.type === 'error') {
                setFailed(true)
              } else if (message?.type === 'rendered') {
                setHeight(message.height)
              }
            }}
          />
        )
      }
    />
  )
}
