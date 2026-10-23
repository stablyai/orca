import { useMemo, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { MobilePreviewModeToolbar, type MobilePreviewMode } from './MobilePreviewModeToolbar'
import { htmlPreviewWithInertLinks } from './html-preview-inert-links'
import { useHtmlPreviewLinkGrant } from './use-html-preview-link-grant'

export type MobileHtmlPreviewProps = {
  html: string
  // Rendered when the user flips to "Source" (the existing syntax view).
  renderSource: () => React.ReactNode
  /** The toolbar's trailing action, e.g. Copy. */
  trailing?: ReactNode
}

/**
 * The `sandbox` the preview frame carries, and the whole of what makes it safe to render an
 * agent-produced artifact inside the page's own document.
 *
 * No `allow-scripts`: a script in the artifact does not run. No `allow-same-origin`: the frame is an
 * opaque origin, so it reaches no storage, no cookie and nothing the page holds — and it is not
 * same-origin with the document the shell injects its bridge object into, which Chromium places in
 * every same-origin frame. The shell refuses a non-main-frame bridge message by rule as well, so
 * that fence is two deep.
 *
 * `allow-top-navigation-by-user-activation` is the one capability granted, and it is what keeps a
 * link in the artifact working (ruling 29): a tap becomes a top-frame navigation the shell's
 * navigation policy cancels and hands to its external-link opener. Measured on Chromium and WebKit:
 * a user click produces exactly one top-frame navigation, while a `<meta http-equiv="refresh">`, a
 * form submit and `target="_blank"` produce none, and with scripts deliberately enabled a
 * script-initiated `window.top.location` throws `SecurityError`. Only a human's tap gets out.
 *
 * And only if the shell on the other side of that tap has somewhere to send it. A shell built
 * before the cancelled-navigation event drops the navigation in silence, so `externalNavigation` is
 * asked for first (C8.1, ruling 37.2) and without it the artifact renders with its links as text.
 * Hidden and not degraded: the document paints, the toggle works, the Source tab is untouched.
 */
export const MOBILE_HTML_PREVIEW_SANDBOX = 'allow-top-navigation-by-user-activation'

/**
 * The same frame against a shell that cannot open what a tap would aim at.
 *
 * The token buys nothing there: the shell cancels the navigation and drops it, so a tap would do
 * nothing and the page would be offering an affordance it cannot honour. Dropping it is the second
 * of the two fences the inert-link pass sets -- see `html-preview-inert-links.ts` for why neither
 * stands in for the other. Everything else about the frame is unchanged, opaque origin and all.
 */
export const MOBILE_HTML_PREVIEW_SEALED_SANDBOX = ''

/**
 * The artifact rendered in a sealed frame, with a Preview/Source toggle.
 *
 * `srcdoc` rather than a `blob:` URL, measured: `srcdoc` is admitted under the policy the shell
 * already ships, because a `srcdoc` frame has no URL to match and inherits its embedder's policy
 * instead, while a `blob:` frame is refused by `frame-src 'none'` on both engines and refused a
 * second time in WebKit by the `frame-ancestors 'none'` it inherits. So this costs no CSP change at
 * all.
 *
 * What the inherited policy then governs is everything the artifact tries to fetch: `img-src` bounds
 * its images, `font-src 'none'` refuses a web font, `connect-src 'self'` its XHR, and
 * `script-src 'self'` refuses its inline script even if the sandbox had allowed scripts.
 *
 * Since `img-src` gained `https:`, this frame loads a remote image.
 *
 * That image URL is a channel: it fires on view and carries whatever the artifact's author encoded
 * in it, so a rendered artifact can tell its own author it was opened. Nothing dynamic goes with it
 * -- no script runs, so the URL is fixed when the artifact is written. What keeps the document's
 * own origin off that request is the shell's `Referrer-Policy: no-referrer` header and not
 * `referrerPolicy` below: measured in the render rig, WebKit sends the embedder's URL from a srcdoc
 * frame's image despite the attribute, where Chromium sends none.
 */
export function MobileHtmlPreview({ html, renderSource, trailing }: MobileHtmlPreviewProps) {
  const [mode, setMode] = useState<MobilePreviewMode>('preview')
  // The shell's answer for this session, asked once: the page mounts after `init` and a session's
  // grants do not change for the life of the document.
  const linksOpen = useHtmlPreviewLinkGrant()
  // Only the path that rewrites pays for a parse, and only when the artifact changes.
  const rendered = useMemo(
    () => (linksOpen ? html : htmlPreviewWithInertLinks(html)),
    [html, linksOpen]
  )

  return (
    <View style={styles.container}>
      <MobilePreviewModeToolbar
        mode={mode}
        onModeChange={setMode}
        trailing={trailing}
        testIDPrefix="html-preview-mode-"
      />
      {/* The Source tab shows what the author wrote, never the rewrite: the rewrite is a rendering
          decision about this shell, and a reader who flipped to Source to read the markup would
          otherwise be shown markup that was never in the artifact. */}
      {mode === 'preview' ? <PreviewFrame html={rendered} linksOpen={linksOpen} /> : renderSource()}
    </View>
  )
}

/**
 * The frame, as a DOM element react-native-web passes through untouched.
 *
 * Written as an `iframe` rather than through a react-native primitive because there is no primitive
 * for it, and `srcdoc` is set as an attribute so React never has to be told the content is trusted:
 * the browser parses it inside a frame that can run nothing.
 */
function PreviewFrame({ html, linksOpen }: { html: string; linksOpen: boolean }) {
  return (
    <View style={styles.frame}>
      <iframe
        title="HTML preview"
        sandbox={linksOpen ? MOBILE_HTML_PREVIEW_SANDBOX : MOBILE_HTML_PREVIEW_SEALED_SANDBOX}
        srcDoc={html}
        style={IFRAME_STYLE}
        // The artifact is untrusted, so nothing it navigates to may learn where it came from or
        // reach back through `window.opener`. Belt and braces beside the sandbox, which already
        // refuses `window.open` -- and only that: measured, this does not reach a subresource the
        // frame's document fetches on WebKit, which is why the shell serves `Referrer-Policy`.
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

const styles = StyleSheet.create({
  container: { flex: 1 },
  frame: { flex: 1, backgroundColor: '#ffffff' }
})
