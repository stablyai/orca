import { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
import { MERMAID_DIAGRAM_CONFIG } from './mermaid-diagram-config'
import { loadPageMermaid } from './mermaid-page-engine'

export type MermaidDiagramProps = {
  source: string
  base: number
}

// Deferred pre-bundled engine stays unevaluated without diagrams; one artifact avoids 103 scripts against 256-asset shell cap (ruling 28).
// No separate sandbox process: mermaid strict mode sanitizes serialized SVG via DOMPurify before insertion; hostile fixtures run on both engines in mobile-web-app-mermaid-render.test.mjs.
// Source is a JS string argument, never inline-script interpolation.
export const MermaidDiagram = memo(function MermaidDiagram({ source, base }: MermaidDiagramProps) {
  const hostRef = useRef<View>(null)
  // Remember failing source, not flag, so next source need not clear failure through effect.
  const [failedSource, setFailedSource] = useState<string | null>(null)
  // Sanitize React id for CSS identifier because mermaid embeds #id rules; do not assume React’s current _R_0_ spelling.
  const suffix = useId().replace(/[^\w-]/g, '')
  const id = `orca-mermaid-${suffix}`
  const failed = failedSource === source

  useEffect(() => {
    // react-native-web renders View as a div and forwards the ref to it.
    const host = hostRef.current
    if (!(host instanceof HTMLElement)) {
      return
    }
    let disposed = false
    void (async () => {
      try {
        const mermaid = await loadPageMermaid()
        mermaid.initialize(MERMAID_DIAGRAM_CONFIG)
        const { svg } = await mermaid.render(id, source)
        if (disposed) {
          return
        }
        // Only mermaid sanitizes its serialization; strict mode already made returned SVG safe to parse.
        host.innerHTML = svg
      } catch {
        if (!disposed) {
          setFailedSource(source)
        }
      }
    })()
    return () => {
      disposed = true
      // React owns container, not mermaid contents; clear prior diagram on source change.
      host.replaceChildren()
    }
  }, [id, source])

  if (failed) {
    return (
      <MermaidFrame>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.fallbackScroll}
          testID="mermaid-diagram-source"
        >
          <Text style={[styles.fallbackText, { fontSize: base - 1 }]}>{source}</Text>
        </ScrollView>
      </MermaidFrame>
    )
  }

  return (
    <MermaidFrame>
      <View ref={hostRef} style={styles.host} />
    </MermaidFrame>
  )
})

/** The frame and label, so a diagram and its fallback sit in the same box. */
function MermaidFrame({ children }: { children: ReactNode }) {
  return (
    <View style={styles.frame} testID="mermaid-diagram">
      <View style={styles.label}>
        <Text style={styles.labelText}>mermaid</Text>
      </View>
      {children}
    </View>
  )
}

// No rule reaches the SVG: mermaid emits it with `width="100%"` and its own natural `max-width`.
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
  host: { padding: spacing.sm },
  fallbackScroll: { padding: spacing.sm },
  fallbackText: { color: colors.textPrimary, fontFamily: typography.monoFamily }
})
