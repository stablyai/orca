import { readableMermaidFlowchartSvg } from '../../../../src/shared/mermaid-flowchart-contrast'
import { useMobileTheme } from '../../theme/use-mobile-theme'
import { createThemedStyles } from '../../theme/mobile-themed-styles'
import { memo, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../../theme/mobile-theme'
export type MermaidDiagramProps = { source: string; base: number }
import { MERMAID_DIAGRAM_CONFIG } from './mermaid-diagram-config'
import { useMobileTranscriptLayoutPending } from '../mobile-transcript-layout'
import { enqueuePageMermaidRender, loadPageMermaid } from './mermaid-page-engine'

/** Render sanitized diagrams in the phone page, with source fallback on failure. */
export const MermaidDiagram = memo(function MermaidDiagram(props: MermaidDiagramProps) {
  const scheme = useMobileTheme()
  return <MermaidDiagramRender key={`${scheme}\0${props.source}`} {...props} />
})

function MermaidDiagramRender({ source, base }: MermaidDiagramProps) {
  const hostRef = useRef<View>(null)
  // A new source/theme mounts a fresh attempt; obsolete callbacks cannot poison its fallback.
  const [failed, setFailed] = useState(false)
  const [settled, setSettled] = useState(false)
  useMobileTranscriptLayoutPending(!settled && !failed)
  // mermaid writes `#<id>` into the stylesheet it puts inside the SVG, so this has to be a CSS
  // identifier. React spells its own `_R_0_`; the strip is for a React that changes that.
  const suffix = useId().replace(/[^\w-]/g, '')
  const id = `orca-mermaid-${suffix}`

  useEffect(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: react-native-web renders View as a div and forwards the ref to it; this module only ever runs in that build.
    const host = hostRef.current as unknown as HTMLElement | null
    if (!host) {
      return
    }
    let disposed = false
    // A stuck render must not leave every later diagram waiting indefinitely.
    let timer = setTimeout(() => setFailed(true), 30_000)
    enqueuePageMermaidRender(async () => {
      try {
        if (disposed) {
          return
        }
        clearTimeout(timer)
        timer = setTimeout(() => setFailed(true), 10_000)
        const mermaid = await loadPageMermaid()
        if (disposed) {
          return
        }
        mermaid.initialize(MERMAID_DIAGRAM_CONFIG)
        const { svg } = await mermaid.render(id, source)
        if (disposed) {
          return
        }
        // Already sanitized: `securityLevel: 'strict'` is what makes this string safe to parse,
        // and mermaid is the only thing that can sanitize its own serialization.
        host.innerHTML = readableMermaidFlowchartSvg(svg, colors.textPrimary, colors.bgRaised)
        setSettled(true)
      } catch {
        if (!disposed) {
          setFailed(true)
        }
      } finally {
        clearTimeout(timer)
      }
    })
    return () => {
      disposed = true
      clearTimeout(timer)
      // React owns this element, not what mermaid put inside it, so nothing else clears the
      // previous diagram when the source changes.
      host.replaceChildren()
    }
    // A timeout must dispose the attempt before a late SVG can publish.
  }, [id, source, failed])

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
}

/** Diagrams and source fallbacks share one frame. */
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

// Mermaid owns the SVG dimensions.
const styles = createThemedStyles(() =>
  StyleSheet.create({
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
)
