import { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
// The native component's own prop type, so a change to it fails here rather than drifting.
import type { MermaidDiagramProps } from './MermaidDiagram'
import { MERMAID_DIAGRAM_CONFIG } from './mermaid-diagram-config'
import { loadPageMermaid } from './mermaid-page-engine'

/**
 * Web sibling: the same diagram, drawn by mermaid in this document.
 *
 * The native component seals the source inside a `WebView` whose document embeds the whole engine
 * as a string, because `react-native-webview` has no browser counterpart and mermaid has no native
 * renderer. On the page neither half of that applies: mermaid is a browser library, so it is an
 * `import()` rather than a 3.7 MB literal, and there is no second content process to sandbox in.
 *
 * What replaces the sandbox is mermaid's own `securityLevel: 'strict'`, which runs the serialized
 * SVG through DOMPurify before handing it back — a `<script>`, an `on*` attribute or a
 * `javascript:` href in a diagram label reaches this document as nothing at all. That is measured
 * in `config/scripts/mobile-web-app-mermaid-render.test.mjs`, in both engines, against a hostile
 * fixture, and so is the byte equality of the result with the native document's own render. The
 * native path's `</script>` escaping has no analogue here and does not need one: the source is a
 * JS string argument, not text spliced into an inline `<script>`.
 *
 * The import is inside the effect, so a session with no diagram in it evaluates none of the engine
 * (ruling 28). It reaches the engine through `mermaid-page-engine.ts`, which loads one pre-bundled
 * artifact rather than the package: importing the package here emitted 103 scripts, all of them
 * already inside the generation the phone downloaded.
 */
export const MermaidDiagram = memo(function MermaidDiagram({ source, base }: MermaidDiagramProps) {
  const hostRef = useRef<View>(null)
  // The source that failed, rather than a flag: a flag would need clearing from the effect that
  // renders the next one, and a render the component has already failed is the only thing the
  // fallback is about.
  const [failedSource, setFailedSource] = useState<string | null>(null)
  // mermaid writes `#<id>` into the stylesheet it puts inside the SVG, so this has to be a CSS
  // identifier. React spells its own `_R_0_`; the strip is for a React that changes that.
  const suffix = useId().replace(/[^\w-]/g, '')
  const id = `orca-mermaid-${suffix}`
  const failed = failedSource === source

  useEffect(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: react-native-web renders View as a div and forwards the ref to it; this module only ever runs in that build.
    const host = hostRef.current as unknown as HTMLElement | null
    if (!host) {
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
        // Already sanitized: `securityLevel: 'strict'` is what makes this string safe to parse,
        // and mermaid is the only thing that can sanitize its own serialization.
        host.innerHTML = svg
      } catch {
        if (!disposed) {
          setFailedSource(source)
        }
      }
    })()
    return () => {
      disposed = true
      // React owns this element, not what mermaid put inside it, so nothing else clears the
      // previous diagram when the source changes.
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

/** The native component's frame and label, so a diagram and its fallback sit in the same box. */
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

// The native component's own styles, so the page's diagram sits in the box that component draws.
// No rule reaches the SVG: mermaid emits it with `width="100%"` and its own natural `max-width`,
// and a rule of ours on the element would be a byte the native document's render does not have.
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
