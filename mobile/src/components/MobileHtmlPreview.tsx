import { useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { Code, Eye } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

type Props = {
  html: string
  // Rendered when the user flips to "Source" (the existing syntax view).
  renderSource: () => React.ReactNode
}

// Renders an agent-produced HTML artifact in a sandboxed WebView, with a
// Preview/Source toggle. Navigation is locked: only the initial inline document
// loads in-place; any link tap opens externally so a page can't hijack the
// review surface.
export function MobileHtmlPreview({ html, renderSource }: Props) {
  const [mode, setMode] = useState<'preview' | 'source'>('preview')

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Pressable
          style={[styles.toggle, mode === 'preview' && styles.toggleActive]}
          onPress={() => setMode('preview')}
          accessibilityLabel="Preview rendered HTML"
        >
          <Eye size={13} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.toggleText}>Preview</Text>
        </Pressable>
        <Pressable
          style={[styles.toggle, mode === 'source' && styles.toggleActive]}
          onPress={() => setMode('source')}
          accessibilityLabel="View HTML source"
        >
          <Code size={13} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.toggleText}>Source</Text>
        </Pressable>
      </View>
      {mode === 'preview' ? (
        <WebView
          style={styles.webview}
          originWhitelist={['*']}
          source={{ html }}
          javaScriptEnabled
          // Why: only the initial about:blank inline-HTML load is allowed in
          // place; a tapped link opens in the system browser instead of
          // navigating the review WebView away from the artifact.
          onShouldStartLoadWithRequest={(request) => {
            if (request.url === 'about:blank' || request.url.startsWith('data:')) {
              return true
            }
            void Linking.openURL(request.url).catch(() => {})
            return false
          }}
        />
      ) : (
        renderSource()
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  toolbar: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.bgRaised
  },
  toggleActive: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  toggleText: { color: colors.textSecondary, fontSize: typography.metaSize },
  webview: { flex: 1, backgroundColor: '#ffffff' }
})
