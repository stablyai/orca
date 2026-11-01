import { useMemo, useState } from 'react'
import { View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobilePreviewSourceTabs, type MobilePreviewMode } from './MobilePreviewSourceTabs'
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
  const [mode, setMode] = useState<MobilePreviewMode>('preview')
  // Read immutable session grants once after init, before page mounts.
  const linksOpen = useHtmlPreviewLinkGrant()
  // Only the path that rewrites pays for a parse, and only when the artifact changes.
  const rendered = useMemo(
    () => (linksOpen ? html : htmlPreviewWithInertLinks(html)),
    [html, linksOpen]
  )

  return (
    <View style={styles.container}>
      <MobilePreviewSourceTabs
        mode={mode}
        onModeChange={setMode}
        previewLabel={t('components.htmlPreview.previewRenderedHtml', 'Preview rendered HTML')}
        sourceLabel={t('components.htmlPreview.viewHtmlSource', 'View HTML source')}
      />
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
  frame: { flex: 1, backgroundColor: '#ffffff' }
}))
