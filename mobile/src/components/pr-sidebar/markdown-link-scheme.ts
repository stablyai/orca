// Allowlist untrusted Markdown URL schemes before OS dispatch; never permit javascript/file/app-deep-link handlers.
const ALLOWED_SCHEMES = ['http:', 'https:', 'mailto:']

export function isAllowedMarkdownLinkUrl(url: string): boolean {
  try {
    return ALLOWED_SCHEMES.includes(new URL(url).protocol)
  } catch {
    return false
  }
}
