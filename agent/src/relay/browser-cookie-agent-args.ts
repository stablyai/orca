// agent/src/relay/browser-cookie-agent-args.ts
// agent-browser `cookies set` arg builder (new — no desktop equivalent,
// since desktop writes cookies into an Electron session/SQLite DB directly;
// the agent instead shells out to agent-browser's CLI per cookie). Flags
// confirmed against the real vendored CLI's `cookies --help` output at
// implementation time (agent/node_modules/agent-browser, ~0.27.0):
// `cookies set <name> <value> [--url] [--domain] [--path] [--httpOnly]
// [--secure] [--sameSite Strict|Lax|None] [--expires <unix-seconds>]`.
// Split out of browser-profile-detect.ts.

import type { ValidatedCookie } from './browser-cookie-normalize'

function agentBrowserSameSiteFlag(sameSite: ValidatedCookie['sameSite']): string | null {
  switch (sameSite) {
    case 'strict':
      return 'Strict'
    case 'lax':
      return 'Lax'
    case 'no_restriction':
      return 'None'
    default:
      return null
  }
}

export function buildAgentBrowserCookieSetArgs(cookie: ValidatedCookie): string[] {
  const args = [
    'cookies',
    'set',
    cookie.name,
    cookie.value,
    '--url',
    cookie.url,
    '--domain',
    cookie.domain,
    '--path',
    cookie.path
  ]
  if (cookie.httpOnly) {
    args.push('--httpOnly')
  }
  if (cookie.secure) {
    args.push('--secure')
  }
  const sameSiteFlag = agentBrowserSameSiteFlag(cookie.sameSite)
  if (sameSiteFlag) {
    args.push('--sameSite', sameSiteFlag)
  }
  if (cookie.expirationDate !== undefined) {
    args.push('--expires', String(cookie.expirationDate))
  }
  return args
}
