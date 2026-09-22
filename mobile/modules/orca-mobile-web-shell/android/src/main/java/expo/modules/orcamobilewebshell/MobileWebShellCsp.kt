package expo.modules.orcamobilewebshell

/**
 * Sent as a response header on the document and nowhere else: a served document must never carry
 * its own policy, so there is no meta tag to find and no bundle change that can relax it. Kept in
 * step with the iOS copy.
 */
internal val MOBILE_WEB_SHELL_CSP = listOf(
  "default-src 'none'",
  "script-src 'self'",
  // React Native Web 0.21.2 injects its stylesheet at runtime with no nonce support, so the
  // Phase C page cannot paint under 'self' alone (measured: the render check under this exact
  // header). This relaxes styling only; script-src 'self' is untouched.
  "style-src 'self' 'unsafe-inline'",
  // `data:` because a file preview has no other shape: the desktop answers a base64 body and the
  // page composes `data:<mime>;base64,<content>` for React Native Web's Image. `https:` for the
  // remote images the page already tries to render and cannot: an agent's favicon, which is a fixed
  // `google.com/s2/favicons` URL; a project's icon, which is a favicon, an avatar or an upload the
  // host names; and whatever an artifact names inside the sealed HTML preview frame, which inherits
  // this policy because a `srcdoc` frame has no URL of its own.
  //
  // Not markdown, not the rich editor and not a review comment's avatar, whatever a later reader
  // assumes from ruling 26: markdown paints `![](...)` as a tappable link, the editor is still a
  // plain source field, and the avatar is skipped under `Platform.OS !== 'web'` by a card that pins
  // the skip in a test. All three are anticipated surfaces, and C7.10 is where they become real
  // ones.
  //
  // The bound is the destination, not the provenance. CSP matches both as schemes, so this admits
  // any image URL of either and cannot tell one the page composed from one it was handed; for
  // `data:` the mime type and the body are both the host's, and the page only checks the mime type
  // is a non-empty string. What holds is that the URL is never fetched as anything but an image:
  // img-src is the only directive admitting them, an image fetch executes nothing (an SVG inside an
  // <img> runs no script), and script-src 'self', connect-src 'self' and object-src 'none' are
  // untouched. What `https:` adds is a request whose target the rendered content chose, so a
  // document can learn it was opened; the shell's Referrer-Policy header keeps the session id out.
  //
  // `http:` stays out: it reaches no image TLS cannot serve, and a cleartext image is readable and
  // replaceable in flight by anything on the path.
  "img-src 'self' data: https:",
  "font-src 'none'",
  // The origin is one read-only directory behind the manifest map, so 'self' reaches nothing the
  // page cannot already read, and the bootstrap page reads ./manifest.json through it. This is the
  // fence for fetch and XMLHttpRequest; the document-start script covers only the two things the
  // native layer cannot see.
  "connect-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
).joinToString("; ")
