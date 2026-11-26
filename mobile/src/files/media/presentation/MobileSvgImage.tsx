import { useMemo, useState } from 'react'
import { View } from 'react-native'
import { WebView } from 'react-native-webview'
import { escapeLiteralHtml } from '../../../components/rich-markdown/serialization/markdown-escaping'

export function isSvgDataUri(uri: string): boolean {
  return /^data:image\/svg\+xml[;,]/i.test(uri)
}

// Render the SVG as an image so scripts and external references inside it stay inert.
function svgImageDocument(uri: string): string {
  return `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-svg-preview'">
<style>html,body{margin:0;height:100%;overflow:hidden}img{display:block;width:100%;height:100%;object-fit:contain}</style>
<img alt="" data-src="${escapeLiteralHtml(uri)}">
<script nonce="svg-preview">
{
  const image = document.querySelector('img');
  image.onload = () => window.ReactNativeWebView.postMessage(image.naturalWidth + ',' + image.naturalHeight);
  image.onerror = () => window.ReactNativeWebView.postMessage('error');
  image.src = image.dataset.src;
}
</script>`
}

export function MobileSvgImage({
  uri,
  label,
  width,
  availableWidth,
  onError
}: {
  uri: string
  label: string
  width?: number
  availableWidth?: number
  onError?: () => void
}) {
  const source = useMemo(() => ({ html: svgImageDocument(uri), baseUrl: 'about:blank' }), [uri])
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const displayWidth = size && availableWidth ? Math.min(width ?? size.width, availableWidth) : 1
  const style =
    availableWidth === undefined
      ? { flex: 1 }
      : { width: displayWidth, height: size ? (displayWidth * size.height) / size.width : 1 }
  return (
    <View pointerEvents="none" style={style} accessibilityRole="image" accessibilityLabel={label}>
      <WebView
        source={source}
        style={{ backgroundColor: 'transparent' }}
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={({ url }) => url === 'about:blank'}
        allowFileAccess={false}
        javaScriptEnabled
        scrollEnabled={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onError={onError}
        onMessage={({ nativeEvent: { data } }) => {
          const dimensions = /^([1-9]\d{0,9}),([1-9]\d{0,9})$/.exec(data)
          if (dimensions) {
            setSize({ width: Number(dimensions[1]), height: Number(dimensions[2]) })
          } else {
            onError?.()
          }
        }}
      />
    </View>
  )
}
