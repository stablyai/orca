enum MobileWebShellCsp {
  /// Native document-response policy cannot be relaxed by a bundle/meta tag; keep both platforms in sync.
  static let header = [
    "default-src 'none'",
    "script-src 'self'",
    // React Native Web 0.21.2 injects styles without nonces; allow inline styling while keeping script-src 'self'.
    "style-src 'self' 'unsafe-inline'",
    // data: supports base64 file previews; https: supports agent/project icons and sealed srcdoc images.
    // Markdown images remain links, the editor is plain source, and web review avatars are skipped (C7.10).
    // Scheme matching constrains destination, not provenance/MIME/body: any image URL is allowed.
    // Image/SVG fetches cannot execute script; script/connect/object policies remain strict. HTTPS images
    // can reveal a document was opened, so Referrer-Policy hides session identity. Exclude mutable cleartext http:.
    "img-src 'self' data: blob: https:",
    // Terminal fonts use bundled same-origin assets or embedded data URLs.
    "font-src 'self' data:",
    // fetch/XHR can read only this generation’s manifest-mapped directory, including bootstrap’s manifest.json.
    // The document-start blocker covers WebSocket and service-worker APIs that native cannot intercept.
    "connect-src 'self'",
    // Media previews play bytes downloaded through authenticated RPC, never a network URL.
    "media-src blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    // Preserve srcdoc’s about: base/in-page links without admitting network bases.
    "base-uri about:",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].joined(separator: "; ")
}
