import { useEffect, useMemo, useRef, useState } from 'react'
import { Platform, Text, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { radii, spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../theme/themed-styles'
import { DEFAULT_TERMINAL_THEME } from '../../terminal-webview-html/theme'
import type { TerminalFontStyle } from '../terminal-font-style'
import { terminalFontPreviewHtml, terminalFontPreviewLook } from './terminal-font-preview-html'

type Props = {
  textScale: number
  fontStyle: TerminalFontStyle
  /** The terminal width the column count is for. */
  columnsWidth: number
  height: number
}

// RN Text cannot draw bundled woff2 fonts, so the preview is a small WebView with the real font.
export function TerminalFontPreview({ textScale, fontStyle, columnsWidth, height }: Props) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const webViewRef = useRef<WebView>(null)
  const look = terminalFontPreviewLook(textScale, fontStyle, Platform.OS === 'ios')
  const lookJson = JSON.stringify(look)
  // Rebuild only when the font file changes; size, spacing and weight are pushed into the open page.
  const source = useMemo(
    () => ({ html: terminalFontPreviewHtml(fontStyle.font, look) }),
    [fontStyle.font]
  )
  const apply = () =>
    webViewRef.current?.injectJavaScript(
      `window.__orcaPreview && window.__orcaPreview(${lookJson});true;`
    )
  useEffect(apply, [lookJson])

  const [cellWidth, setCellWidth] = useState<number | null>(null)
  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const msg: unknown = JSON.parse(event.nativeEvent.data)
      if (
        typeof msg === 'object' &&
        msg !== null &&
        'cellWidth' in msg &&
        typeof msg.cellWidth === 'number' &&
        msg.cellWidth > 0
      ) {
        setCellWidth(msg.cellWidth)
      }
    } catch {}
  }
  const columns = cellWidth && columnsWidth > 0 ? Math.floor(columnsWidth / cellWidth) : null
  const columnsLabel =
    columns === null
      ? ' '
      : columns === 1
        ? t('app.terminalSettings.previewColumns_one', '{{count}} column', { count: columns })
        : t('app.terminalSettings.previewColumns_other', '{{count}} columns', { count: columns })

  return (
    <View
      style={styles.frame}
      accessible
      accessibilityLabel={t('app.terminalSettings.previewLabel', 'Terminal preview')}
      accessibilityValue={columns === null ? undefined : { text: columnsLabel }}
    >
      {/* Touches pass through, so dragging over the preview scrolls the screen. */}
      <View pointerEvents="none" style={{ height }}>
        <WebView
          ref={webViewRef}
          source={source}
          style={styles.webview}
          originWhitelist={['*']}
          javaScriptEnabled
          scrollEnabled={false}
          // Like the terminal: OS font scaling must not change what the preview measures.
          textZoom={100}
          onLoadEnd={apply}
          onMessage={onMessage}
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
        />
      </View>
      <Text style={styles.columns}>{columnsLabel}</Text>
    </View>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  frame: {
    borderRadius: radii.surface,
    overflow: 'hidden',
    backgroundColor: DEFAULT_TERMINAL_THEME.background
  },
  webview: { flex: 1, backgroundColor: DEFAULT_TERMINAL_THEME.background },
  // The frame is always the dark terminal, in either app theme.
  columns: {
    alignSelf: 'flex-end',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    fontSize: 11,
    color: DEFAULT_TERMINAL_THEME.white,
    opacity: 0.7
  }
}))
