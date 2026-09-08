import { useMemo } from 'react'
import { StyleSheet } from 'react-native'
import { WebView } from 'react-native-webview'
import {
  buildMobileHtmlPreviewDocument,
  parseMobileHtmlPreviewMessage
} from './mobile-html-preview-document'
import { MobileHtmlPreviewPresentation } from './mobile-html-preview-presentation'

type Props = {
  html: string
  onOpenLink?: (url: string) => void
  // Rendered when the user flips to "Source" (the existing syntax view).
  renderSource: () => React.ReactNode
}

export function MobileHtmlPreview({ html, onOpenLink, renderSource }: Props) {
  const document = useMemo(() => buildMobileHtmlPreviewDocument(html), [html])
  return (
    <MobileHtmlPreviewPresentation
      renderSource={renderSource}
      preview={
        <WebView
          style={styles.webview}
          originWhitelist={['about:blank']}
          source={{ html: document }}
          javaScriptEnabled
          javaScriptCanOpenWindowsAutomatically={false}
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
          onMessage={(event) => {
            const url = parseMobileHtmlPreviewMessage(event.nativeEvent.data)
            if (url) {
              onOpenLink?.(url)
            }
          }}
        />
      }
    />
  )
}

const styles = StyleSheet.create({
  webview: { flex: 1, backgroundColor: '#ffffff' }
})
