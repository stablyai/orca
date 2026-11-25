import { describe, expect, it } from 'vitest'
import { parseClaudePastedCodeSignInLink } from './claude-pasted-code-login'

const FULL_LINK =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=c&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=x&code_challenge_method=S256&state=s'
// Claude Code 2.1.330+ prints this shortened form of the pasted-code link.
const SHORT_LINK = 'https://claude.ai/oauth/authorize?z-NZrn99lU0utPsxoS7gLTLznomO3DEOpwXwGKyRG4zJs'
const hyperlink = (url: string): string => `\x1b]8;;${url}\x07${url}\x1b]8;;\x07\n`

describe('parseClaudePastedCodeSignInLink', () => {
  it.each([FULL_LINK, SHORT_LINK])('accepts %s', (link) => {
    expect(parseClaudePastedCodeSignInLink(`Visit:\n${hyperlink(link)}Paste code > `)).toBe(link)
  })

  it.each([
    FULL_LINK.replace('https%3A%2F%2Fplatform.claude.com', 'http%3A%2F%2Flocalhost%3A123'),
    FULL_LINK.replace('https%3A%2F%2Fplatform.claude.com', 'http%3A%2F%2F127.0.0.1%3A123'),
    'https://platform.claude.com/oauth/authorize?code=true',
    'https://claude.ai/x/cai/oauth/authorize?z-abc',
    'https://claude.ai/login'
  ])('rejects %s', (link) => {
    expect(parseClaudePastedCodeSignInLink(hyperlink(link))).toBeNull()
  })
})
