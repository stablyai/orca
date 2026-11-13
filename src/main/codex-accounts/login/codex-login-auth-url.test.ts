import { describe, expect, it } from 'vitest'
import { parseCodexLoginAuthUrl } from './codex-login-auth-url'

const AUTH_URL = 'https://auth.openai.com/oauth/authorize?client_id=orca&state=abc123'

describe('parseCodexLoginAuthUrl', () => {
  it('waits for a chunk boundary rather than publishing a truncated link', () => {
    const truncated = `If your browser did not open, navigate to this URL to authenticate:\n\n${AUTH_URL.slice(0, 40)}`
    expect(parseCodexLoginAuthUrl(truncated)).toBe(null)
    expect(parseCodexLoginAuthUrl(`${truncated}${AUTH_URL.slice(40)}\n`)).toBe(AUTH_URL)
  })
})
