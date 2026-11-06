import type { AcpDialect } from '../acp/acp-dialects/acp-dialect'

export const GEMINI_ACP_DIALECT: AcpDialect = {
  authenticationRequired: (error) => error.code === 401,
  promptFailure: (error) => (error.code === 429 ? { stopReason: 'rate_limit' } : undefined)
}

/** Manual OAuth consumes stdin; close signed out before it can read ACP frames as a code. */
export function readGeminiAcpSignInLine(line: string): string | null | undefined {
  const text = line.trim()
  if (!text.startsWith('https://accounts.google.com/')) {
    return undefined
  }
  if (text.length > 16_384 || !URL.canParse(text)) {
    return null
  }
  const url = new URL(text)
  return url.origin === 'https://accounts.google.com' &&
    url.pathname === '/o/oauth2/v2/auth' &&
    url.searchParams.get('redirect_uri') === 'https://codeassist.google.com/authcode' &&
    url.searchParams.get('response_type') === 'code'
    ? text
    : null
}
