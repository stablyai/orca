import { afterEach, describe, expect, it, vi } from 'vitest'
import { installClaudeProfileRouter } from '../claude-profile-installed-router'
import { readClaudeOAuthCredentials } from '../../rate-limits/claude-oauth-credentials'
import {
  bindClaudeAuthProxyAccountDir,
  readClaudeAuthProxyAccessToken,
  stopClaudeAuthProxy
} from './claude-auth-proxy-host'

vi.mock('../../rate-limits/claude-oauth-credentials', () => ({
  readClaudeOAuthCredentials: vi.fn()
}))

afterEach(async () => {
  installClaudeProfileRouter(undefined)
  await stopClaudeAuthProxy()
})

describe('readClaudeAuthProxyAccessToken', () => {
  it('returns null when the credential read throws and does not log the secret', async () => {
    vi.mocked(readClaudeOAuthCredentials).mockRejectedValue(new Error('sk-ant-secret-token'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    bindClaudeAuthProxyAccountDir('acct', '/tmp/claude-home')
    await expect(readClaudeAuthProxyAccessToken('acct')).resolves.toBeNull()
    const logged = [...warn.mock.calls, ...info.mock.calls, ...error.mock.calls].flat().join(' ')
    expect(logged).not.toContain('sk-ant-secret-token')
    warn.mockRestore()
    info.mockRestore()
    error.mockRestore()
  })

  it('returns null when the reader reports the store unavailable', async () => {
    vi.mocked(readClaudeOAuthCredentials).mockResolvedValue({
      token: null,
      hasRefreshableCredentials: false,
      source: 'credentials-file',
      unavailable: true
    })
    bindClaudeAuthProxyAccountDir('acct', '/tmp/claude-home')
    await expect(readClaudeAuthProxyAccessToken('acct')).resolves.toBeNull()
  })
})
