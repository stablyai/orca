import { useEffect, useRef, useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import Constants from 'expo-constants'
import { StatusBar } from 'expo-status-bar'
import { useRouter } from 'expo-router'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft } from 'lucide-react-native'
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview'
import { OrcaLocalRuntime } from '../modules/orca-local-runtime/src'
import { canRunLocalHost } from '../src/local-runtime/local-runtime-availability'
import {
  THEME_REPORTER_SCRIPT,
  buildSafeAreaScript,
  parseThemeMessage
} from '../src/local-runtime/desktop-webview-bridge'
import { useSoftKeyboard } from '../src/platform/keyboard-occlusion'
import { colors, spacing, typography } from '../src/theme/mobile-theme'

/**
 * The full desktop UI (Orca's web client) served by the on-device host, drawn edge to edge: the
 * page paints under the status and navigation bars and keeps its chrome clear of them itself.
 * Only loopback pages load in place; anything else is a link that belongs in the system browser.
 */
export default function DesktopScreen() {
  const router = useRouter()
  const runtime = canRunLocalHost() ? OrcaLocalRuntime : null
  const [url, setUrl] = useState(() => runtime?.getStatus().webClientUrl ?? null)
  const [pageDark, setPageDark] = useState(false)
  const webViewRef = useRef<WebView>(null)
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'))
  const insets = useSafeAreaInsets()
  // Edge-to-edge Android no longer resizes the window for the IME, so shrink the page ourselves;
  // otherwise the keyboard covers the lower half of every dialog and the terminal prompt.
  const keyboard = useSoftKeyboard()
  // With the keyboard up it, not the navigation bar, is the bottom edge the page must clear.
  const pageInsets = { ...insets, bottom: keyboard.visible ? 0 : insets.bottom }
  const safeAreaScript = buildSafeAreaScript(pageInsets)

  useEffect(() => {
    if (!runtime) {
      return
    }
    const sub = runtime.addListener('onStatus', (status) => setUrl(status.webClientUrl))
    return () => sub.remove()
  }, [runtime])

  useEffect(() => {
    webViewRef.current?.injectJavaScript(safeAreaScript)
  }, [safeAreaScript])

  if (!url) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={goBack} hitSlop={12} accessibilityLabel="Back">
            <ChevronLeft size={22} color={colors.textPrimary} />
          </Pressable>
          <Text style={styles.title}>Desktop</Text>
        </View>
        <Text style={styles.body}>
          Start the on-device host with an orcad bundle that includes the desktop web client.
        </Text>
      </SafeAreaView>
    )
  }

  const origin = new URL(url).origin
  const stayInApp = (request: WebViewNavigation) => {
    if (request.url.startsWith(origin) || request.url.startsWith('about:')) {
      return true
    }
    void Linking.openURL(request.url)
    return false
  }
  const onMessage = (event: WebViewMessageEvent) => {
    const dark = parseThemeMessage(event.nativeEvent.data)
    if (dark !== null) {
      setPageDark(dark)
    }
  }

  return (
    <View style={[styles.edgeToEdge, keyboard.visible && { paddingBottom: keyboard.height }]}>
      <StatusBar style={pageDark ? 'light' : 'dark'} translucent />
      <WebView
        ref={webViewRef}
        source={{ uri: url }}
        style={[styles.web, pageDark ? styles.webDark : styles.webLight]}
        originWhitelist={[`${origin}*`, 'about:*']}
        onShouldStartLoadWithRequest={stayInApp}
        injectedJavaScriptBeforeContentLoaded={`${safeAreaScript}${THEME_REPORTER_SCRIPT}`}
        onMessage={onMessage}
        setSupportMultipleWindows={false}
        domStorageEnabled
        javaScriptEnabled
        allowFileAccess={false}
        // Desktop layout at a readable scale; the user can still pinch to zoom.
        scalesPageToFit
        setBuiltInZoomControls
        setDisplayZoomControls={false}
        keyboardDisplayRequiresUserAction={false}
        webviewDebuggingEnabled={Constants.expoConfig?.extra?.orcaWebViewDebugging === true}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  edgeToEdge: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md
  },
  title: { fontSize: typography.titleSize, fontWeight: '600', color: colors.textPrimary },
  body: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    lineHeight: 20,
    paddingHorizontal: spacing.lg
  },
  web: { flex: 1 },
  // Matches the page's own background so the first frame and overscroll don't flash.
  webLight: { backgroundColor: colors.surfaceBright },
  webDark: { backgroundColor: colors.bgBase }
})
