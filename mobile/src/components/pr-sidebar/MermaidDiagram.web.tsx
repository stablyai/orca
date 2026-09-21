import { memo } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
// The native component's own prop type, so a change to it fails here rather than drifting.
import type { MermaidDiagramProps } from './MermaidDiagram'

/**
 * Web sibling: the labelled source box, which is what the native component already falls back to.
 *
 * The native one renders the diagram inside a sandboxed `WebView`, and `react-native-webview` is a
 * native component with no browser counterpart — importing it runs a codegen lookup that throws,
 * and the route manifest imports every route, so one such import takes the whole page down rather
 * than one diagram.
 *
 * A real web renderer is reachable — mermaid is a browser library and the engine bundle is already
 * vendored — but it is a different shape from the native path, not a smaller one: no WebView to
 * sandbox untrusted source in, so the escaping the native `buildHtml` does for `</script>` and the
 * line separators would have to be replaced by whatever the DOM path needs. That is its own change
 * with its own proof, so this series ships the degradation the component already defines and says
 * so, rather than a second renderer nobody has tested against hostile diagram source.
 */
export const MermaidDiagram = memo(function MermaidDiagram({ source, base }: MermaidDiagramProps) {
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
})

// The native component's own fallback styles, so the degradation looks like the state that
// component already renders rather than a second design.
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
  fallbackScroll: { padding: spacing.sm },
  fallbackText: { color: colors.textPrimary, fontFamily: typography.monoFamily }
})
