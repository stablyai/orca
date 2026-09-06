import { describe, expect, it } from 'vitest'
import { MobileWebBrowserAuthority } from './mobile-web-browser-authority'

describe('mobile web browser authority', () => {
  it('isolates opaque page handles by workspace and revokes only retired pages', () => {
    const authority = new MobileWebBrowserAuthority((length) => new Uint8Array(length).fill(9))
    const first = authority.register('workspace-a', 'raw-page')
    const second = authority.register('workspace-b', 'raw-page')

    expect(first).toMatch(/^browser_0_[a-f0-9]{32}$/)
    expect(second).toMatch(/^browser_1_[a-f0-9]{32}$/)
    expect(first).not.toContain('raw-page')
    expect(authority.register('workspace-a', 'raw-page')).toBe(first)
    expect(authority.hostPageId('workspace-a', first)).toBe('raw-page')
    expect(() => authority.hostPageId('workspace-b', first)).toThrow('not_found')

    authority.synchronizeWorkspace('workspace-a', [])

    expect(() => authority.hostPageId('workspace-a', first)).toThrow('not_found')
    expect(authority.hostPageId('workspace-b', second)).toBe('raw-page')
  })

  it('resolves browser session tab handles and clears them with the shell session', () => {
    const authority = new MobileWebBrowserAuthority((length) => new Uint8Array(length))
    const pageId = authority.register('workspace-a', 'raw-page')

    expect(authority.hostTabId('workspace-a', pageId)).toBe('raw-page')
    expect(authority.hostTabId('workspace-a', 'terminal-1')).toBe('terminal-1')

    authority.clear()

    expect(() => authority.hostPageId('workspace-a', pageId)).toThrow('not_found')
    expect(() => authority.hostTabId('workspace-a', pageId)).toThrow('not_found')
  })
})
