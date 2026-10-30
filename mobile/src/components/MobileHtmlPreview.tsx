import { useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Code, Eye } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { htmlPreviewWithInertLinks } from './html-preview-inert-links'
import { useHtmlPreviewLinkGrant } from './use-html-preview-link-grant'

export type MobileHtmlPreviewProps = {
  html: string
  // Rendered when the user flips to "Source" (the existing syntax view).
  renderSource: () => React.ReactNode
}

// Deny scripts/same-origin: artifact gets opaque origin without storage/cookies or shell bridge; native also rejects non-main-frame messages.
// Grant user-activated top navigation only after externalNavigation negotiation (C8.1/ruling 37.2): shell cancels tapped links and opens them externally.
// Chromium/WebKit probes allow human tap only; meta refresh/forms/_blank produce no top request and script navigation throws. Older shells render inert links as text.
export const MOBILE_HTML_PREVIEW_SANDBOX = 'allow-top-navigation-by-user-activation'

// Without externalNavigation, omit navigation sandbox token too: older shell cancels/drops taps. Keep this fence and html-preview-inert-links rewrite; neither replaces other.
export const MOBILE_HTML_PREVIEW_SEALED_SANDBOX = ''

// Use srcdoc: inherits shipped CSP without matching frame-src; blob is blocked by frame-src none and WebKit frame-ancestors none.
// Inherited img/font/connect/script policies still constrain artifact; https images can report view through fixed author URL, but scripts cannot add dynamic data.
// Shell Referrer-Policy:no-referrer is required: WebKit ignores iframe referrerPolicy for srcdoc images, unlike Chromium.
export function MobileHtmlPreview({ html, renderSource }: MobileHtmlPreviewProps) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  // Read immutable session grants once after init, before page mounts.
  const linksOpen = useHtmlPreviewLinkGrant()
  // Only the path that rewrites pays for a parse, and only when the artifact changes.
  const rendered = useMemo(
    () => (linksOpen ? html : htmlPreviewWithInertLinks(html)),
    [html, linksOpen]
  )

  return (
    <View style={styles.container}>
      {/* Expose selected tab to assistive readers; active styling alone is silent. */}
      <View style={styles.toolbar} accessibilityRole="tablist">
        <Pressable
          style={[styles.toggle, mode === 'preview' && styles.toggleActive]}
          onPress={() => setMode('preview')}
          accessibilityRole="tab"
          // Set both native accessibilityState and web aria-selected: RN Web drops former without emitting latter.
          accessibilityState={{ selected: mode === 'preview' }}
          aria-selected={mode === 'preview'}
          accessibilityLabel={t(
            'components.htmlPreview.previewRenderedHtml',
            'Preview rendered HTML'
          )}
        >
          <Eye size={13} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.toggleText}>{t('components.htmlPreview.preview', 'Preview')}</Text>
        </Pressable>
        <Pressable
          style={[styles.toggle, mode === 'source' && styles.toggleActive]}
          onPress={() => setMode('source')}
          accessibilityRole="tab"
          accessibilityState={{ selected: mode === 'source' }}
          aria-selected={mode === 'source'}
          accessibilityLabel={t('components.htmlPreview.viewHtmlSource', 'View HTML source')}
        >
          <Code size={13} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.toggleText}>{t('components.htmlPreview.source', 'Source')}</Text>
        </Pressable>
      </View>
      {/* Show author’s original source; inert-link rewrite is only this shell’s rendering policy. */}
      {mode === 'preview' ? <PreviewFrame html={rendered} linksOpen={linksOpen} /> : renderSource()}
    </View>
  )
}

// Use DOM iframe: RN has no primitive. Set srcdoc attribute to parse untrusted content only inside sealed frame.
function PreviewFrame({ html, linksOpen }: { html: string; linksOpen: boolean }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <View style={styles.frame}>
      <iframe
        title={t('components.htmlPreview.title', 'HTML preview')}
        sandbox={linksOpen ? MOBILE_HTML_PREVIEW_SANDBOX : MOBILE_HTML_PREVIEW_SEALED_SANDBOX}
        srcDoc={html}
        style={IFRAME_STYLE}
        // Prevent navigation referrer/opener access alongside sandbox’s window.open denial; WebKit subresource referrers still require shell header.
        referrerPolicy="no-referrer"
      />
    </View>
  )
}

/** A DOM style, not a `StyleSheet` entry: this element is an `iframe` and not a react-native view. */
const IFRAME_STYLE = {
  border: 'none',
  width: '100%',
  height: '100%',
  // The artifact decides its own background; an unset one here would show the panel through it.
  backgroundColor: '#ffffff'
} as const

const styles = themedStyleSheet(() => ({
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
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  toggleActive: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  toggleText: { color: colors.textSecondary, fontSize: typography.metaSize },
  frame: { flex: 1, backgroundColor: '#ffffff' }
}))
