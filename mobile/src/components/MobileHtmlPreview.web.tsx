import { StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
// The native component's own prop type, so a change to it fails here rather than drifting.
import type { MobileHtmlPreviewProps } from './MobileHtmlPreview'

/**
 * Web sibling: the labelled source, which is the half of this component the native one already
 * renders on its own — `renderSource` is its Source tab, reached by the toggle above it.
 *
 * The native preview renders the artifact inside a sandboxed `WebView` whose navigation is locked
 * to the initial inline document, and `react-native-webview` is a native component with no browser
 * counterpart: importing it runs a codegen lookup that throws, and the route manifest imports every
 * route, so one such import takes the whole page down rather than one preview.
 *
 * Rendering the HTML here instead is not a smaller change but a different one (ruling 8), and the
 * difference is the sandbox: the page has no nested frame to put untrusted agent-produced HTML in —
 * the shell's policy carries `frame-src 'none'` and `child-src 'none'` — so a browser renderer
 * would need its own sanitiser and its own proof against hostile source. The toggle goes with the
 * preview, because a control that can only be in one position is a control that lies.
 */
export function MobileHtmlPreview({ renderSource }: MobileHtmlPreviewProps) {
  return (
    <View style={styles.container}>
      <View style={styles.label}>
        <Text style={styles.labelText}>html source</Text>
      </View>
      <View style={styles.source}>{renderSource()}</View>
    </View>
  )
}

// The native component's own frame, so the degradation sits where the preview sat.
const styles = StyleSheet.create({
  container: { flex: 1 },
  label: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  labelText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily
  },
  source: { flex: 1 }
})
