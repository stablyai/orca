import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Maximize2 } from 'lucide-react-native'
import { colors, radii, spacing, typography, pressedStyle } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { readableMermaidFlowchartSvg } from '../../../../src/shared/mermaid-flowchart-contrast'
import { readSvgIntrinsicSize, svgMarkupDataUri } from '../../../../src/shared/svg-document'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { MobileNativeChatImageViewer } from '../../session/native-chat/visual/MobileNativeChatImageViewer'
import { mermaidDiagramConfig } from './mermaid-diagram-config'
import { loadPageMermaid } from './mermaid-page-engine'

export type MermaidDiagramProps = {
  source: string
  base: number
}

// Deferred pre-bundled engine stays unevaluated without diagrams; one artifact avoids 103 scripts against 256-asset shell cap (ruling 28).
// No separate sandbox process: mermaid strict mode sanitizes serialized SVG via DOMPurify before insertion; hostile fixtures run on both engines in mobile-web-app-mermaid-render.test.mjs.
// Source is a JS string argument, never inline-script interpolation.
export const MermaidDiagram = memo(function MermaidDiagram({ source, base }: MermaidDiagramProps) {
  const colorScheme = useMobileColorScheme()
  const hostRef = useRef<View>(null)
  // Remember failing source, not flag, so next source need not clear failure through effect.
  const [failedSource, setFailedSource] = useState<string | null>(null)
  // Sanitize React id for CSS identifier because mermaid embeds #id rules; do not assume React’s current _R_0_ spelling.
  const suffix = useId().replace(/[^\w-]/g, '')
  const id = `orca-mermaid-${suffix}`
  const failed = failedSource === source
  // The drawn diagram, kept by source so a new source never expands a stale drawing.
  const [drawn, setDrawn] = useState<{ source: string; svg: string } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const drawnSvg = drawn?.source === source ? drawn.svg : null

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
        mermaid.initialize(mermaidDiagramConfig(colorScheme))
        const { svg } = await mermaid.render(id, source)
        if (disposed) {
          return
        }
        // Only mermaid sanitizes its serialization; strict mode already made returned SVG safe to parse.
        const readable = readableMermaidFlowchartSvg(svg, colors.textPrimary, colors.bgRaised)
        host.innerHTML = readable
        // An image is an XML document: re-serialize the parsed drawing so HTML-only output like <br> and &nbsp; still loads.
        const drawing = host.querySelector('svg')
        setDrawn({
          source,
          svg: drawing ? new XMLSerializer().serializeToString(drawing) : readable
        })
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
  }, [colorScheme, id, source])

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
    <MermaidFrame onExpand={drawnSvg ? () => setExpanded(true) : undefined}>
      {/* The header button is the accessible control; the drawing is a tap shortcut. */}
      <Pressable
        style={({ pressed }) => pressed && pressedStyle}
        accessible={false}
        disabled={!drawnSvg}
        onPress={() => setExpanded(true)}
      >
        <View ref={hostRef} style={styles.host} />
      </Pressable>
      {expanded && drawnSvg ? (
        <ExpandedDiagram svg={drawnSvg} onClose={() => setExpanded(false)} />
      ) : null}
    </MermaidFrame>
  )
})

function ExpandedDiagram({ svg, onClose }: { svg: string; onClose: () => void }) {
  const t = useMobileTranslation()
  // An <img> never runs the markup, and the viewer redraws the vector at every zoom.
  const uri = useMemo(() => svgMarkupDataUri(svg), [svg])
  const size = useMemo(() => readSvgIntrinsicSize(svg), [svg])
  return (
    <MobileNativeChatImageViewer
      uri={uri}
      size={size}
      upscale
      label={t('components.mermaidDiagram.label', 'Mermaid diagram')}
      onClose={onClose}
    />
  )
}

/** The frame and label, so a diagram and its fallback sit in the same box. */
function MermaidFrame({ children, onExpand }: { children: ReactNode; onExpand?: () => void }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const expandLabel = t('components.mermaidDiagram.expand', 'Expand diagram')
  return (
    <View style={styles.frame} testID="mermaid-diagram">
      <View style={styles.label}>
        <Text style={styles.labelText}>mermaid</Text>
        {onExpand ? (
          <Pressable
            style={({ pressed }) => pressed && pressedStyle}
            onPress={onExpand}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={expandLabel}
          >
            <Maximize2 size={13} color={colors.textSecondary} strokeWidth={2} />
          </Pressable>
        ) : null}
      </View>
      {children}
    </View>
  )
}

// No rule reaches the SVG: mermaid emits it with `width="100%"` and its own natural `max-width`.
const styles = themedStyleSheet(() => ({
  frame: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    backgroundColor: colors.bgRaised
  },
  label: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
}))
