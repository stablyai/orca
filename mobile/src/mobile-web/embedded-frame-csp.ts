/**
 * Policy the native shell serves for the package's embedded frame documents (mermaid, markdown
 * editor). The in-app WebView mermaid document reuses the shape over its own inline script.
 *
 * `scriptSources` is spelled out by the caller because the frames are sandboxed: WebKit resolves
 * `'self'` against the frame's opaque origin, so a served frame has to name the package origin to
 * load its own script. Chromium accepts `'self'` there; WebKit does not.
 */
export function mobileWebEmbeddedFrameCspDirectives(scriptSources: string) {
  return [
    "default-src 'none'",
    `script-src ${scriptSources}`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    "font-src 'none'",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'"
  ] as const
}

export function mobileWebEmbeddedFrameCsp(scriptSources: string): string {
  return mobileWebEmbeddedFrameCspDirectives(scriptSources).join('; ')
}
