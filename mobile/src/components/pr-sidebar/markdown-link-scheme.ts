// Markdown links come from untrusted comment/PR bodies, so the scheme is gated to a
// safe allowlist before opening — never hand an arbitrary scheme (javascript:, file:,
// app deep links) to the OS URL handler.
const ALLOWED_SCHEMES = ['http:', 'https:', 'mailto:']

export function isAllowedMarkdownLinkUrl(url: string): boolean {
  try {
    return ALLOWED_SCHEMES.includes(new URL(url).protocol)
  } catch {
    return false
  }
}
