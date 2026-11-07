import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternalMock } = vi.hoisted(() => ({
  openExternalMock: vi.fn<(url: string) => Promise<void>>()
}))

vi.mock('electron', () => ({ shell: { openExternal: openExternalMock } }))

import { isOpenableAccountSignInLink, openAccountSignInLink } from './account-sign-in-link-opener'

const CLAUDE_LINK =
  'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A5000%2Fcallback&state=s'
const CODEX_LINK =
  'https://auth.openai.com/oauth/authorize?client_id=orca&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=abc'

const UNOPENABLE: [string, 'claude' | 'codex', string][] = [
  ['plain http', 'codex', CODEX_LINK.replace('https:', 'http:')],
  ['plain http', 'claude', CLAUDE_LINK.replace('https:', 'http:')],
  ['a file URL', 'codex', 'file:///etc/passwd'],
  ['a javascript URL', 'claude', 'javascript:alert(1)'],
  ['a custom scheme', 'codex', 'ms-settings:network'],
  ['malformed text', 'codex', 'not a url'],
  ['an empty string', 'claude', ''],
  ['credentials in the URL', 'codex', 'https://user:pw@auth.openai.com/oauth/authorize'],
  ['an explicit port', 'codex', 'https://auth.openai.com:8443/oauth/authorize'],
  ['a lookalike host', 'codex', 'https://auth.openai.com.evil.test/oauth/authorize'],
  ['another provider', 'codex', CLAUDE_LINK],
  ['another provider', 'claude', CODEX_LINK],
  [
    'a Claude link that calls back elsewhere',
    'claude',
    CLAUDE_LINK.replace('localhost', 'evil.test')
  ]
]

describe('account sign-in link opener', () => {
  beforeEach(() => {
    openExternalMock.mockReset()
    openExternalMock.mockResolvedValue(undefined)
  })

  it.each([
    ['claude', CLAUDE_LINK],
    ['codex', CODEX_LINK]
  ] as const)('opens a %s sign-in page', (provider, link) => {
    expect(isOpenableAccountSignInLink(provider, link)).toBe(true)
    openAccountSignInLink(provider, link)
    expect(openExternalMock).toHaveBeenCalledExactlyOnceWith(new URL(link).toString())
  })

  it.each(UNOPENABLE)('never opens %s (%s)', (_label, provider, link) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(isOpenableAccountSignInLink(provider, link)).toBe(false)
    openAccountSignInLink(provider, link)
    expect(openExternalMock).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('survives the OS failing to open the browser', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    openExternalMock.mockRejectedValueOnce(new Error('no handler'))
    expect(() => openAccountSignInLink('codex', CODEX_LINK)).not.toThrow()
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    warn.mockRestore()
  })
})
