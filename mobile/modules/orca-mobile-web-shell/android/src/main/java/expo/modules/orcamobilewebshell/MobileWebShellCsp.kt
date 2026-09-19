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
  // page composes `data:<mime>;base64,<content>` for React Native Web's Image.
  //
  // The bound is the destination, not the provenance. CSP matches `data:` as a scheme, so this
  // admits any `data:` image URL and cannot tell one the page composed from one it was handed;
  // the mime type and the body are both the host's, and the page only checks the mime type is a
  // non-empty string. What holds is that the URL is never fetched as anything but an image:
  // img-src is the only directive admitting it, an image fetch executes nothing (an SVG inside
  // an <img> runs no script), and script-src 'self', connect-src 'self' and object-src 'none'
  // are untouched.
  "img-src 'self' data:",
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
