import { useMemo, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'

type Props = {
  source: string
  base: number
}

// Renders a ```mermaid fence as a diagram via a sandboxed WebView (mermaid has no
// native RN renderer). Mermaid is loaded from a CDN inside the WebView HTML, the
// SVG is themed dark to match the sidebar, and the WebView posts back its rendered
// height so we can size to content. On any failure (no network, parse error,
// render error) we fall back to the raw source in a labeled mono code box.
export function MermaidDiagram({ source, base }: Props) {
  const [height, setHeight] = useState(0)
  const [failed, setFailed] = useState(false)
  const html = useMemo(() => buildHtml(source), [source])

  if (failed) {
    return <MermaidFallback source={source} base={base} />
  }

  return (
    <View style={styles.frame}>
      <View style={styles.label}>
        <Text style={styles.labelText}>mermaid</Text>
      </View>
      <WebView
        style={[styles.webview, { height: height || 120 }]}
        originWhitelist={['*']}
        source={{ html }}
        javaScriptEnabled
        scrollEnabled={false}
        // Diagram is self-contained; any navigation attempt means something is
        // wrong, so treat it as a render failure and fall back to source.
        onShouldStartLoadWithRequest={(request) => {
          if (request.url === 'about:blank' || request.url.startsWith('data:')) {
            return true
          }
          setFailed(true)
          return false
        }}
        onError={() => setFailed(true)}
        onHttpError={() => setFailed(true)}
        onMessage={(event) => {
          const data = event.nativeEvent.data
          if (data === 'error') {
            setFailed(true)
            return
          }
          const parsed = Number(data)
          if (Number.isFinite(parsed) && parsed > 0) {
            setHeight(Math.ceil(parsed))
          }
        }}
      />
    </View>
  )
}

function MermaidFallback({ source, base }: Props) {
  return (
    <View style={styles.frame}>
      <View style={styles.label}>
        <Text style={styles.labelText}>mermaid</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.fallbackScroll}>
        <Text style={[styles.fallbackText, { fontSize: base - 1 }]}>{source}</Text>
      </ScrollView>
    </View>
  )
}

// Self-contained HTML: load mermaid from CDN, render the graph, post the body
// height (or "error") back to RN. Theme variables match the dark sidebar palette.
function buildHtml(source: string): string {
  // JSON.stringify safely escapes the user's diagram source for embedding.
  const encoded = JSON.stringify(source)
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<style>
  html, body { margin: 0; padding: 0; background: ${colors.bgRaised}; }
  #c { padding: 8px; }
  #c svg { max-width: 100%; height: auto; }
</style>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
</head>
<body>
<div id="c"><pre class="mermaid"></pre></div>
<script>
  function post(msg) {
    if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(String(msg)); }
  }
  function reportHeight() {
    post(document.getElementById('c').scrollHeight);
  }
  try {
    document.querySelector('.mermaid').textContent = ${encoded};
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
      darkMode: true,
      themeVariables: {
        background: '${colors.bgRaised}',
        primaryColor: '${colors.bgPanel}',
        primaryTextColor: '${colors.textPrimary}',
        lineColor: '${colors.textSecondary}',
        textColor: '${colors.textPrimary}'
      }
    });
    mermaid.run({ querySelector: '.mermaid' })
      .then(reportHeight)
      .catch(function () { post('error'); });
  } catch (e) {
    post('error');
  }
</script>
</body>
</html>`
}

const styles = StyleSheet.create({
  frame: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    backgroundColor: colors.bgRaised
  },
  label: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  labelText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontFamily: typography.monoFamily
  },
  webview: { backgroundColor: colors.bgRaised },
  fallbackScroll: { padding: spacing.sm },
  fallbackText: { color: colors.textPrimary, fontFamily: typography.monoFamily }
})
