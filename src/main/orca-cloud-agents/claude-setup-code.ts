// The code Claude's sign-in page shows ("Authentication code — Paste this into Claude Code"), as the
// person pastes it into Orca: the bare `code#state`, or the whole callback URL copied from the address
// bar. Normalized here before it is typed into the waiting `claude setup-token`; never logged or kept.

// Anthropic's codes and states are URL-safe base64 joined by '#'.
const CODE_SHAPE = /^[A-Za-z0-9_-]{8,512}(?:#[A-Za-z0-9_-]{8,512})?$/
const CALLBACK_HOSTS = new Set([
  'platform.claude.com',
  'console.anthropic.com',
  'claude.ai',
  'claude.com'
])

/** The code the CLI expects, or null when the paste isn't one (the caller says so, without echoing it). */
export function normalizeClaudeSetupCode(raw: string): string | null {
  const value = raw.trim()
  // A setup-token or API key pasted here is not a sign-in code; it never goes to the CLI's prompt.
  if (/^sk-ant-/i.test(value)) {
    return null
  }
  if (/^https:\/\//i.test(value)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return null
    }
    if (!CALLBACK_HOSTS.has(url.hostname)) {
      return null
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code) {
      return null
    }
    const joined = state ? `${code}#${state}` : code
    return CODE_SHAPE.test(joined) ? joined : null
  }
  return CODE_SHAPE.test(value) ? value : null
}
