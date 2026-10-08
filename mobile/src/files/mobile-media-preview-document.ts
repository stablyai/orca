import { escapeHtml } from '../components/rich-markdown/markdown-escaping'
import { colors, spacing, typography } from '../theme/mobile-theme'

export function mobileMediaPreviewDocument(uri: string, mimeType: string, title: string): string {
  const tag = mimeType.startsWith('audio/') ? 'audio' : 'video'
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src file: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%;background:${colors.bgBase};color:${colors.textSecondary};font:${typography.bodySize}px system-ui}
body{display:flex;align-items:center;justify-content:center;padding:${spacing.md}px;box-sizing:border-box}
video{width:100%;max-height:100%}audio{width:100%}p{text-align:center}
</style></head><body>
<${tag} controls playsinline preload="metadata" src="${escapeHtml(uri)}" aria-label="${escapeHtml(title)}"
onerror="this.hidden=true;document.getElementById('error').hidden=false"></${tag}>
<p id="error" role="alert" hidden>Unable to play this media file. Its codec may not be supported on this device.</p>
</body></html>`
}
