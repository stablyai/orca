import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Code, Eye } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
// The native component's own prop type, so a change to it fails here rather than drifting.
import type { MobileHtmlPreviewProps } from './MobileHtmlPreview'

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
 */
export const MOBILE_HTML_PREVIEW_SANDBOX = 'allow-top-navigation-by-user-activation'

/**
 * Web sibling: the artifact rendered in a sealed frame, with the native component's Preview/Source
 * toggle intact.
 *
 * `srcdoc` rather than a `blob:` URL, measured: `srcdoc` is admitted under the policy the shell
 * already ships, because a `srcdoc` frame has no URL to match and inherits its embedder's policy
 * instead, while a `blob:` frame is refused by `frame-src 'none'` on both engines and refused a
 * second time in WebKit by the `frame-ancestors 'none'` it inherits. So this costs no CSP change at
 * all, and the policy stays exactly what the Phase E native build carries.
 *
 * What the inherited policy then governs is everything the artifact tries to fetch: `img-src` bounds
 * its images, `font-src 'none'` refuses a web font, `connect-src 'self'` its XHR, and
 * `script-src 'self'` refuses its inline script even if the sandbox had allowed scripts.
 *
 * Images are the one of those four that is no longer stricter than native. `script-src 'self'`,
 * `font-src 'none'` and `connect-src 'self'` still are -- the native preview is a separate WebView
 * process with no policy on its document, so it runs a script, loads a web font and reaches any
 * host -- but since `img-src` gained `https:` this frame loads a remote image exactly as native
 * does.
 *
 * That image URL is a channel: it fires on view and carries whatever the artifact's author encoded
 * in it, so a rendered artifact can tell its own author it was opened. Nothing dynamic goes with it
 * -- no script runs, so the URL is fixed when the artifact is written. What keeps the document's
 * own origin off that request is the shell's `Referrer-Policy: no-referrer` header and not
 * `referrerPolicy` below: measured in the render rig, WebKit sends the embedder's URL from a srcdoc
 * frame's image despite the attribute, where Chromium sends none.
 */
export function MobileHtmlPreview({ html, renderSource }: MobileHtmlPreviewProps) {
  const [mode, setMode] = useState<'preview' | 'source'>('preview')

  return (
    <View style={styles.container}>
      {/* A tab pair, not two buttons: which side is showing is carried by the active style, and a
          style is announced to nobody. */}
      <View style={styles.toolbar} accessibilityRole="tablist">
        <Pressable
          style={[styles.toggle, mode === 'preview' && styles.toggleActive]}
          onPress={() => setMode('preview')}
          accessibilityRole="tab"
          // Both, because they reach different readers: `accessibilityState` is what the phone's
          // screen reader takes, and react-native-web drops it entirely -- measured, the DOM carries
          // no `aria-selected` without the line below.
          accessibilityState={{ selected: mode === 'preview' }}
          aria-selected={mode === 'preview'}
          accessibilityLabel="Preview rendered HTML"
        >
          <Eye size={13} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.toggleText}>Preview</Text>
        </Pressable>
        <Pressable
          style={[styles.toggle, mode === 'source' && styles.toggleActive]}
          onPress={() => setMode('source')}
          accessibilityRole="tab"
          accessibilityState={{ selected: mode === 'source' }}
          aria-selected={mode === 'source'}
          accessibilityLabel="View HTML source"
        >
          <Code size={13} color={colors.textSecondary} strokeWidth={2.2} />
          <Text style={styles.toggleText}>Source</Text>
        </Pressable>
      </View>
      {mode === 'preview' ? <PreviewFrame html={html} /> : renderSource()}
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
function PreviewFrame({ html }: { html: string }) {
  return (
    <View style={styles.frame}>
      <iframe
        title="HTML preview"
        sandbox={MOBILE_HTML_PREVIEW_SANDBOX}
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
  // The artifact decides its own background; white is what the native preview shows behind one that
  // sets none, and an unset background here would show the panel through it.
  backgroundColor: '#ffffff'
} as const

const styles = StyleSheet.create({
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
    borderRadius: 6,
    backgroundColor: colors.bgRaised
  },
  toggleActive: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  toggleText: { color: colors.textSecondary, fontSize: typography.metaSize },
  // The native component's own frame, so the preview sits where the preview sat.
  frame: { flex: 1, backgroundColor: '#ffffff' }
})
