import { assertAgentBrowserOperands } from './agent-browser-operands'

export function agentBrowserCookieSetArguments(cookie: Record<string, unknown>): string[] {
  const { name, value, domain, path, sameSite, expires } = cookie
  assertAgentBrowserOperands('Cookie fields', [name, value, domain, path, sameSite])
  const args = ['cookies', 'set', String(name ?? ''), String(value ?? '')]
  for (const [option, flag] of [
    [domain, '--domain'],
    [path, '--path'],
    [sameSite, '--sameSite'],
    [expires, '--expires']
  ] as const) {
    if (option != null && option !== '') {
      args.push(flag, String(option))
    }
  }
  if (cookie.secure) {
    args.push('--secure')
  }
  if (cookie.httpOnly) {
    args.push('--httpOnly')
  }
  return args
}
