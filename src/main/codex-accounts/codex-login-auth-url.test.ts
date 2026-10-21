import { describe, expect, it } from 'vitest'
import { parseCodexLoginAuthUrl } from './codex-login-auth-url'

const AUTH_URL = 'https://auth.openai.com/oauth/authorize?client_id=orca&state=abc123'

describe('parseCodexLoginAuthUrl', () => {
  it('reads the link codex prints under its browser notice', () => {
    expect(
      parseCodexLoginAuthUrl(
        `Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\n${AUTH_URL}\n`
      )
    ).toBe(AUTH_URL)
  })

  it('ignores the local server line, which authenticates nothing', () => {
    expect(parseCodexLoginAuthUrl('Starting local login server on http://localhost:1455.\n')).toBe(
      null
    )
  })

  it('waits for a chunk boundary rather than publishing a truncated link', () => {
    const truncated = `If your browser did not open, navigate to this URL to authenticate:\n\n${AUTH_URL.slice(0, 40)}`
    expect(parseCodexLoginAuthUrl(truncated)).toBe(null)
    expect(parseCodexLoginAuthUrl(`${truncated}${AUTH_URL.slice(40)}\n`)).toBe(AUTH_URL)
  })

  it('survives the escape sequences a coloured CLI writes around the link', () => {
    expect(
      parseCodexLoginAuthUrl(
        `[1mnavigate to this URL to authenticate:[0m\n\n[4m${AUTH_URL}[0m\n`
      )
    ).toBe(AUTH_URL)
  })

  it('drops sentence punctuation that follows the link', () => {
    expect(
      parseCodexLoginAuthUrl(`navigate to this URL to authenticate: ${AUTH_URL}. Then return here.`)
    ).toBe(AUTH_URL)
  })

  it('reports nothing for output without a link yet', () => {
    expect(parseCodexLoginAuthUrl('')).toBe(null)
    expect(parseCodexLoginAuthUrl('Codex login failed: network unreachable\n')).toBe(null)
  })

  it('offers no link at all rather than an unrelated one when the notice is missing', () => {
    expect(
      parseCodexLoginAuthUrl('A new version of codex is available: https://openai.com/codex\n')
    ).toBe(null)
  })
})
