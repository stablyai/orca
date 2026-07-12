import { describe, expect, it, vi } from 'vitest'
import { BrowserRpcCapabilityRegistry } from './browser-rpc-capability-registry'

describe('BrowserRpcCapabilityRegistry', () => {
  it('locks typed browser methods to one page and worktree', () => {
    const registry = new BrowserRpcCapabilityRegistry({ now: () => 1_000 })
    const capability = registry.create({
      browserPageId: 'page-1',
      browserProfileId: 'profile-1',
      worktreeId: 'repo::/worktree',
      ttlMs: 60_000
    })

    const authorized = registry.authorize(capability.token, {
      id: 'req-1',
      authToken: capability.token,
      method: 'browser.snapshot',
      params: {}
    })

    expect(authorized).toEqual({
      id: 'req-1',
      authToken: capability.token,
      method: 'browser.snapshot',
      params: { page: 'page-1', worktree: 'repo::/worktree' }
    })
  })

  it('rejects page overrides, implicit tab methods, raw exec, and non-browser RPC', () => {
    const registry = new BrowserRpcCapabilityRegistry()
    const capability = registry.create({
      browserPageId: 'page-1',
      browserProfileId: 'profile-1',
      ttlMs: 60_000
    })

    for (const [method, params] of [
      ['browser.snapshot', { page: 'page-2' }],
      ['browser.tabCurrent', {}],
      ['browser.tabSwitch', { page: 'page-1' }],
      ['browser.exec', { page: 'page-1', command: 'get url' }],
      ['browser.upload', { page: 'page-1', element: '@e1', files: ['/etc/passwd'] }],
      ['browser.download', { page: 'page-1', selector: 'a', path: '/tmp/file' }],
      ['terminal.list', {}],
      ['worktree.rm', {}],
      ['browser.profileDelete', { profileId: 'profile-1' }]
    ] as const) {
      expect(() =>
        registry.authorize(capability.token, {
          id: 'req-1',
          authToken: capability.token,
          method,
          params
        })
      ).toThrow()
    }
  })

  it('expires, revokes, and removes all capabilities for a closed page', () => {
    const now = vi.fn(() => 1_000)
    const registry = new BrowserRpcCapabilityRegistry({ now })
    const first = registry.create({
      browserPageId: 'page-1',
      browserProfileId: 'profile-1',
      ttlMs: 100
    })
    const second = registry.create({
      browserPageId: 'page-1',
      browserProfileId: 'profile-1',
      ttlMs: 1_000
    })

    now.mockReturnValue(1_101)
    expect(() => registry.authorize(first.token, request(first.token))).toThrow(/expired/)

    expect(registry.revoke(second.id)).toBe(true)
    expect(() => registry.authorize(second.token, request(second.token))).toThrow(/invalid/i)

    const third = registry.create({
      browserPageId: 'page-1',
      browserProfileId: 'profile-1',
      ttlMs: 1_000
    })
    const other = registry.create({
      browserPageId: 'page-2',
      browserProfileId: 'profile-2',
      ttlMs: 1_000
    })
    expect(registry.revokePage('page-1')).toBe(1)
    expect(() => registry.authorize(third.token, request(third.token))).toThrow(/invalid/i)
    expect(registry.authorize(other.token, request(other.token)).params).toEqual({ page: 'page-2' })
  })

  it('exposes only the bound page and profile for runtime checks', () => {
    const registry = new BrowserRpcCapabilityRegistry()
    const capability = registry.create({
      browserPageId: 'page-1',
      browserProfileId: 'profile-1',
      ttlMs: 1_000
    })

    expect(registry.getTarget(capability.token)).toEqual({
      browserPageId: 'page-1',
      browserProfileId: 'profile-1'
    })
  })
})

function request(authToken: string) {
  return {
    id: 'req-1',
    authToken,
    method: 'browser.snapshot',
    params: {}
  }
}
